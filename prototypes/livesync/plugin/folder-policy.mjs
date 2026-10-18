import {excludedFolders,folderContains,withExcludedFolders} from './folder-exclusions.mjs';
const failure=code=>Object.assign(Error(code),{code});
const workspaceId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const databaseName=value=>typeof value==='string'&&/^arcalink_p_[a-f0-9]{32}$/.test(value);
const bytes=value=>new TextEncoder().encode(value).length;

export function checkedFolderPolicy(value,workspace) {
  if(!workspaceId(workspace)||!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).sort().join(',')!=='caseSensitive,folders,protocol,workspace'
    ||value.protocol!==1||value.workspace!==workspace||typeof value.caseSensitive!=='boolean'
    ||!Array.isArray(value.folders)||value.folders.length>100000)throw failure('invalid-folder-policy');
  let folders;
  try{folders=excludedFolders(withExcludedFolders('',value.folders,value.caseSensitive));}
  catch{throw failure('invalid-folder-policy');}
  return {protocol:1,workspace,folders,caseSensitive:value.caseSensitive};
}

function checkedEnvelope(envelope,encrypted) {
  if(typeof encrypted!=='boolean'||!envelope||typeof envelope!=='object'||Array.isArray(envelope)
    ||Object.keys(envelope).sort().join(',')!=='data,format'||typeof envelope.data!=='string'
    ||bytes(envelope.data)<1||bytes(envelope.data)>60000
    ||!['plain-v1','sealed-v1'].includes(envelope.format))throw failure('invalid-policy-envelope');
  if(encrypted&&envelope.format!=='sealed-v1')throw failure('policy-encryption-required');
  return envelope;
}

/** seal/open are the engine's current encryption functions; keys stay local. */
export async function encodeFolderPolicy(policy,{encrypted,seal}={}) {
  const normalized=checkedFolderPolicy(policy,policy?.workspace);
  const data=JSON.stringify(normalized);
  if(encrypted&&typeof seal!=='function')throw failure('policy-encryption-required');
  const envelope={format:encrypted?'sealed-v1':'plain-v1',data:encrypted?await seal(data):data};
  return checkedEnvelope(envelope,encrypted);
}

export async function decodeFolderPolicy(envelope,workspace,{encrypted,open}={}) {
  checkedEnvelope(envelope,encrypted);
  if(envelope.format==='sealed-v1'&&typeof open!=='function')throw failure('policy-decryption-required');
  let value;
  try{value=JSON.parse(envelope.format==='sealed-v1'?await open(envelope.data):envelope.data);}
  catch{throw failure('policy-unreadable');}
  return checkedFolderPolicy(value,workspace);
}

export function folderPolicyExcludes(policy,path) {
  if(typeof path!=='string')throw failure('invalid-file-path');
  if(path.startsWith('i:'))return false;
  return policy.folders.some(folder=>folderContains(folder,path,policy.caseSensitive));
}

/** Validate before accepting any new server state or starting replication. */
export async function decodeFolderPolicyState(state,workspace,cached,cryptoOptions) {
  if(!state||state.protocol!==1||!workspaceId(workspace)||!databaseName(state.database)
    ||!Number.isSafeInteger(state.revision)||state.revision<0||!['ready','preparing'].includes(state.phase))throw failure('invalid-policy-state');
  if(cached?.workspace===workspace){
    if(state.revision<cached.revision)throw failure('policy-revision-regressed');
    if(state.revision===cached.revision&&cached.phase==='ready'&&cached.revision>0&&state.database!==cached.database)throw failure('policy-generation-regressed');
    if(state.revision===cached.revision&&cached.phase==='ready'&&state.phase==='preparing')throw failure('policy-phase-regressed');
  }
  if(state.revision===0&&(state.envelope!==null||state.phase!=='ready'))throw failure('invalid-policy-state');
  // A cancelled first policy may have a nonzero revision with a null envelope.
  // It still requires a fresh client acknowledgement; do not treat it as legacy.
  const policy=state.envelope===null?checkedFolderPolicy({protocol:1,workspace,folders:[],caseSensitive:false},workspace)
    :await decodeFolderPolicy(state.envelope,workspace,cryptoOptions);
  return {workspace,revision:state.revision,phase:state.phase,database:state.database,policy};
}
