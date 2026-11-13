import {canonicalOwnership} from './companion-ownership-model.mjs';

export const ACTION_CHUNK_BYTES = 256 * 1024;
export const ACTION_MAX_BYTES = 256 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text);
const encryptedChunkOverhead = canonicalOwnership({iv:'A'.repeat(16),ciphertext:''}).length;
const fail = code => Object.assign(Error(code), {code});
const hex = value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
export const actionHash = async value => hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? bytes(value) : value));
const b64 = value => { let text = ''; for (let offset = 0; offset < value.length; offset += 8192) text += String.fromCharCode(...value.subarray(offset, offset + 8192)); return btoa(text); };
const unb64 = value => {
  if (typeof value !== 'string' || value.length > (ACTION_CHUNK_BYTES + 1024) * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail('action-ciphertext-invalid');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
};
function binding(value) {
  const fields = ['accountId', 'workspaceId', 'vaultId', 'operationId', ...(value?.schema === 2 ? ['receiverId', 'ledgerEpoch'] : [])];
  if (!value || ![1, 2].includes(value.schema) || value.schema === 2 && value.mode !== 'p2p' || !fields.every(key => typeof value[key] === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value[key]))) throw fail('action-binding-invalid');
  return Object.fromEntries(['schema', ...(value.schema === 2 ? ['mode'] : []), ...fields].map(key => [key, value[key]]));
}
/** Derive a key for one pinned operation; this key does not reveal the profile key. */
export async function actionOperationKey(secret, identity) {
  identity = binding(identity);
  if (identity.schema !== 2 || typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw fail('action-key-invalid');
  const raw = Uint8Array.from(secret.match(/../g), part => parseInt(part, 16));
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt:bytes('arcalink-actions-operation-v2'), info:bytes(canonicalOwnership(identity))}, key, 256));
  } finally { raw.fill(0); }
}
function path(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || ['.', '..', '.obsidian', '.git', '.livesync'].includes(part))) throw fail('action-path-invalid');
  return value;
}
export function validateActionIntent(value) {
  if (!value || !['create', 'set-checkbox'].includes(value.kind) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw fail('action-intent-invalid');
  path(value.path);
  if (Object.keys(value).some(key => !['kind', 'path', 'createdAt', 'predecessor', 'baseHash', 'task', 'taskLine', 'checked'].includes(key))) throw fail('action-intent-invalid');
  if (value.predecessor != null && !/^[a-zA-Z0-9_-]{8,128}$/.test(value.predecessor)) throw fail('action-predecessor-invalid');
  if (value.kind === 'set-checkbox' && (!/^[a-f0-9]{64}$/.test(value.baseHash) || typeof value.task !== 'string' || value.task.length < 1 || value.task.length > 8192 || typeof value.checked !== 'boolean')) throw fail('action-checkbox-invalid');
  if ('taskLine' in value && (!Number.isSafeInteger(value.taskLine) || value.taskLine < 0 || value.taskLine > 1000000)) throw fail('action-checkbox-invalid');
  if (value.kind === 'create' && ['baseHash', 'task', 'taskLine', 'checked'].some(key => key in value)) throw fail('action-intent-invalid');
  return value;
}
async function keys(secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw fail('action-key-invalid');
  const raw = Uint8Array.from(secret.match(/../g), part => parseInt(part, 16));
  try {
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derive = (purpose, algorithm, usages) => crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: bytes('arcalink-actions-v1'), info: bytes(purpose)}, base, algorithm, false, usages);
    return {cipher: await derive('payload', {name: 'AES-GCM', length: 256}, ['encrypt', 'decrypt']), signature: await derive('manifest', {name: 'HMAC', hash: 'SHA-256', length: 256}, ['sign', 'verify'])};
  } finally { raw.fill(0); }
}
const context = (identity, index, purpose) => bytes(canonicalOwnership({...identity, index, purpose}));
async function encrypt(key, identity, index, purpose, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: context(identity, index, purpose)}, key, plaintext));
  return canonicalOwnership({iv: b64(iv), ciphertext: b64(ciphertext)});
}
async function decrypt(key, identity, index, purpose, envelope) {
  try {
    if (typeof envelope !== 'string' || bytes(envelope).length > 2 * ACTION_CHUNK_BYTES) throw Error();
    const value = JSON.parse(envelope), iv = unb64(value.iv);
    if (iv.length !== 12 || Object.keys(value).some(name => !['iv', 'ciphertext'].includes(name))) throw Error();
    return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: context(identity, index, purpose)}, key, unb64(value.ciphertext)));
  } catch { throw fail('action-authentication-failed'); }
}
async function optionalRead(store, name) {
  try { return await store.read(name) ?? null; }
  catch (error) { if (['ENOENT', 'action-file-missing'].includes(error?.code)) return null; throw error; }
}
async function receiptNames(store){
  const names=await store.receipts?.()??[];
  if(!Array.isArray(names)||names.length>64||names.some(name=>typeof name!=='string'||!/^receipt-[a-f0-9-]{36}\.json$/.test(name)))throw fail('action-receipt-invalid');
  return names;
}

/** Store is scoped to one previously unused operation directory. No shared mutable index.
 * writeNew must refuse an existing name; native adapters additionally read back each
 * durable write. A partial manifest is never a ready operation. No success before readback.
 */
export async function publishAction(store, identity, intent, payload, secret) {
  identity = binding(identity); validateActionIntent(intent);
  if (!(payload instanceof Uint8Array) || payload.length > ACTION_MAX_BYTES) throw fail('action-size-invalid');
  const key = await keys(secret), size = payload.length, payloadHash = await actionHash(payload);
  const intentDigest = await actionHash(canonicalOwnership({identity, intent, size, payloadHash}));
  const result = identity.schema === 2 ? await actionResult(payload, intent) : null;
  const existingManifest = await optionalRead(store, 'manifest.json');
  if (existingManifest !== null) {
    let previous;
    try { previous = await readActionHeader(store, identity, secret); }
    catch (error) {
      if (error?.code !== 'action-incomplete' || !store.removeIncomplete) throw error;
      await store.removeIncomplete('manifest.json', existingManifest);
    }
    if (previous) {
      if (previous.intentDigest !== intentDigest) throw fail('action-id-reused');
      try { await readAction(store, identity, secret); }
      catch (damaged) {
        // A confirmed action may have had its ciphertext pruned. An unsigned or
        // mismatched receipt never turns a damaged, unpublished payload into success.
        let confirmed = false;
        for (const name of await receiptNames(store)) {
          try { if (await openActionReceipt(previous, await store.read(name), secret)) { confirmed = true; break; } }
          catch { /* Ignore partial or foreign receipts. */ }
        }
        if (!confirmed) throw damaged;
      }
      return {operationId: identity.operationId, intentDigest};
    }
  }
  const chunks = [];
  for (let offset = 0, index = 0; offset < size; offset += ACTION_CHUNK_BYTES, index++) {
    const name = `chunk-${index}.json`;
    const plain = payload.subarray(offset, offset + ACTION_CHUNK_BYTES), previous = await optionalRead(store, name);
    let text = previous;
    if (text !== null) {
      let recovered;
      try { recovered = await decrypt(key.cipher, identity, index, 'chunk', text); }
      catch (error) {
        if (error?.code !== 'action-authentication-failed' || !store.removeIncomplete) throw error;
        await store.removeIncomplete(name, text);text = null;
      }
      if (text !== null && await actionHash(recovered) !== await actionHash(plain)) throw fail('action-id-reused');
    }
    if (text === null) {
      text = await encrypt(key.cipher, identity, index, 'chunk', plain);
      await store.writeNew(name, text);
    }
    if (await store.read(name) !== text) throw fail('action-write-unverified');
    chunks.push({index, hash: await actionHash(text), bytes: bytes(text).length});
  }
  const description = await encrypt(key.cipher, identity, -1, 'intent', bytes(canonicalOwnership(result ? {schema:2,intent,...result} : intent)));
  const unsigned = {...identity, size, payloadHash, description, chunks};
  const signature = hex(await crypto.subtle.sign('HMAC', key.signature, bytes(canonicalOwnership(unsigned))));
  const manifest = canonicalOwnership({...unsigned, signature});
  await store.writeNew('manifest.json', manifest);
  if (await store.read('manifest.json') !== manifest) throw fail('action-write-unverified');
  return {operationId: identity.operationId, intentDigest};
}

async function authenticatedHeader(store, expected, secret) {
  const identity = binding(expected), key = await keys(secret);
  const text = await store.read('manifest.json');
  if (typeof text !== 'string' || bytes(text).length > 512 * 1024) throw fail('action-manifest-invalid');
  let value; try { value = JSON.parse(text); } catch { throw fail('action-incomplete'); }
  const {signature, ...unsigned} = value;
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !await crypto.subtle.verify('HMAC', key.signature, Uint8Array.from(signature.match(/../g), part => parseInt(part, 16)), bytes(canonicalOwnership(unsigned)))) throw fail('action-authentication-failed');
  if (canonicalOwnership(binding(value)) !== canonicalOwnership(identity)) throw fail('action-binding-mismatch');
  if (Object.keys(unsigned).some(name => !['schema', 'accountId', 'workspaceId', 'vaultId', 'operationId', ...(identity.schema === 2 ? ['mode', 'receiverId', 'ledgerEpoch'] : []), 'size', 'payloadHash', 'description', 'chunks'].includes(name)) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > ACTION_MAX_BYTES || !/^[a-f0-9]{64}$/.test(value.payloadHash) || !Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(value.size / ACTION_CHUNK_BYTES) || value.chunks.some((chunk,index)=>chunk?.index!==index||!/^[a-f0-9]{64}$/.test(chunk.hash)||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1||chunk.bytes>2*ACTION_CHUNK_BYTES||identity.schema===2&&chunk.bytes!==encryptedChunkOverhead+4*Math.ceil((Math.min(ACTION_CHUNK_BYTES,value.size-index*ACTION_CHUNK_BYTES)+16)/3))) throw fail('action-manifest-invalid');
  const description = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await decrypt(key.cipher, identity, -1, 'intent', value.description)));
  let result;
  if(identity.schema===2 && description?.schema===2){
    if(Object.keys(description).sort().join(',')!=='intent,resultHash,resultSize,schema'||!/^[a-f0-9]{64}$/.test(description.resultHash)||!Number.isSafeInteger(description.resultSize)||description.resultSize<0||description.resultSize>ACTION_MAX_BYTES)throw fail('action-intent-invalid');
    result={resultHash:description.resultHash,resultSize:description.resultSize};
  }
  const intent = validateActionIntent(result ? description.intent : description);
  return {identity,intent,key,value,result,intentDigest:await actionHash(canonicalOwnership({identity,intent,size:value.size,payloadHash:value.payloadHash}))};
}
export async function readActionHeader(store, expected, secret) {
  const {identity,intent,intentDigest}=await authenticatedHeader(store,expected,secret);
  return {identity,intent,intentDigest};
}
export async function readActionDescriptor(store, expected, secret) {
  const {identity,intent,intentDigest,value,result}=await authenticatedHeader(store,expected,secret);
  return {identity,intent,intentDigest,size:value.size,payloadHash:value.payloadHash,...result};
}
export async function confirmedActionChunks(store, expected, secret) {
  const {identity,intent,intentDigest,value}=await authenticatedHeader(store,expected,secret);
  const header={identity,intent,intentDigest};
  for(const name of await receiptNames(store)){
    try{if(await openActionReceipt(header,await store.read(name),secret))return value.chunks.map(chunk=>`chunk-${chunk.index}.json`);}
    catch{/* An invalid receipt cannot authorize cleanup. */}
  }
  return [];
}
export async function readAction(store, expected, secret) {
  const {identity,intent,intentDigest,key,value,result}=await authenticatedHeader(store,expected,secret);
  const payload = new Uint8Array(value.size);
  for (let index = 0; index < value.chunks.length; index++) {
    const chunk = value.chunks[index], contents = await store.read(`chunk-${index}.json`);
    if (chunk.index !== index || typeof contents !== 'string' || bytes(contents).length !== chunk.bytes || await actionHash(contents) !== chunk.hash) throw fail('action-chunk-invalid');
    const plain = await decrypt(key.cipher, identity, index, 'chunk', contents);
    if (plain.length !== Math.min(ACTION_CHUNK_BYTES, value.size - index * ACTION_CHUNK_BYTES)) throw fail('action-chunk-invalid');
    payload.set(plain, index * ACTION_CHUNK_BYTES);
  }
  if (await actionHash(payload) !== value.payloadHash) throw fail('action-payload-invalid');
  if(result && canonicalOwnership(await actionResult(payload,intent))!==canonicalOwnership(result))throw fail('action-payload-invalid');
  return {identity,intent,payload,intentDigest};
}

/** Immutable local receipt: encrypted and bound to this exact authenticated
 * action. It is only minted after the executor's full remote content readback. */
export async function sealActionReceipt(action, result, secret) {
  const identity = binding(action.identity);
  if (!/^[a-f0-9]{64}$/.test(action.intentDigest) || result.state !== 'confirmed' || result.path !== action.intent.path || !/^[a-f0-9]{64}$/.test(result.resultHash) || result.receipt?.operationId !== identity.operationId || result.receipt?.intent !== action.intentDigest || result.receipt?.outcome !== 'confirmed') throw fail('action-receipt-invalid');
  return encrypt((await keys(secret)).cipher, identity, -2, 'receipt', bytes(canonicalOwnership({schema:1,intentDigest:action.intentDigest,...result})));
}

export async function openActionReceipt(action, text, secret) {
  const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(await decrypt((await keys(secret)).cipher, binding(action.identity), -2, 'receipt', text)));
  if (value.schema !== 1 || value.intentDigest !== action.intentDigest || value.state !== 'confirmed' || value.path !== action.intent.path || !/^[a-f0-9]{64}$/.test(value.resultHash) || value.receipt?.operationId !== action.identity.operationId || value.receipt?.intent !== action.intentDigest || value.receipt?.outcome !== 'confirmed') throw fail('action-receipt-invalid');
  return value;
}

/** Preserve exact bytes unless the base matches and one task is unambiguous. */
export async function applyCheckboxIntent(before, intent) {
  validateActionIntent(intent);
  if (intent.kind !== 'set-checkbox' || await actionHash(before) !== intent.baseHash) throw fail('action-base-changed');
  const lines = before.split('\n'), matches = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*?)(\r?)$/);
    if (match && match[4] === intent.task && (intent.taskLine === undefined || index === intent.taskLine)) matches.push({index, match});
  }
  if (matches.length !== 1) throw fail('action-task-ambiguous');
  const {index, match} = matches[0];
  lines[index] = match[1] + (intent.checked ? 'x' : ' ') + match[3] + match[4] + match[5];
  return lines.join('\n');
}

async function actionResult(payload,intent){
  let output=payload;
  if(intent.kind==='set-checkbox'){
    let before;try{before=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);}catch{throw fail('action-payload-invalid');}
    output=bytes(await applyCheckboxIntent(before,intent));
  }
  if(output.length>ACTION_MAX_BYTES)throw fail('action-size-invalid');
  return {resultHash:await actionHash(output),resultSize:output.length};
}
