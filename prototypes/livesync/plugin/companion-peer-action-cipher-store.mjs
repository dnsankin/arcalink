import {actionHash} from './companion-action-outbox.mjs';
import {canonicalOwnership} from './companion-ownership-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
/** Explicit ciphertext files in private Pouch; no vault files or DB RPC. */
export function createPeerActionCipherStore({db,scope,identity}){
 if(!db||!scope||!identity||identity.schema!==2||identity.mode!=='p2p'||!['account','workspace','receiverId','ledgerEpoch','grantId'].every(k=>token(scope[k]))||!['accountId','workspaceId','vaultId','receiverId','ledgerEpoch','operationId'].every(k=>token(identity[k]))||identity.accountId!==scope.account||identity.workspaceId!==scope.workspace||identity.receiverId!==scope.receiverId||identity.ledgerEpoch!==scope.ledgerEpoch)throw fail('action-store-invalid');
 scope=structuredClone(scope);identity=structuredClone(identity);
 async function id(name){if(typeof name!=='string'||!(/^(?:manifest|chunk-(?:0|[1-9][0-9]{0,3}))\.json$/.test(name)))throw fail('action-store-invalid');return '_local/action-file-'+await actionHash(canonicalOwnership([scope,identity,name]));}
 async function read(name){let doc;try{doc=await db.get(await id(name));}catch(e){if(e.status===404)return null;throw e;}if(!doc||doc.schema!==1||typeof doc.value!=='string'||doc.value.length>512*1024||await actionHash(doc.value)!==doc.hash)throw fail('action-store-invalid');return doc.value;}
 async function writeNew(name,value){if(typeof value!=='string'||value.length<1||value.length>512*1024||new TextEncoder().encode(value).length>512*1024)throw fail('action-store-invalid');const document={_id:await id(name),schema:1,value,hash:await actionHash(value)};try{await db.put(document);}catch(e){if(e.status===409)throw fail('action-file-exists');throw e;}if(await read(name)!==value)throw fail('action-write-unverified');}
 return {read,writeNew};
}
