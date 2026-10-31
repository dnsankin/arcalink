import {routingSnapshot} from './shared2-routing.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** Server membership does not itself choose a local mount or publish files.
 * Only explicit local attachments become routes. Revoked/removed attachments
 * retain their old boundary until a separate leave/reverse handshake completes.
 */
export function composeShared2Snapshot({catalog,scope,personal,mounts,previous}){
 if(!catalog||catalog.protocol!==2||catalog.account!==scope.account||!Array.isArray(catalog.folders)||catalog.folders.length>1000||!Array.isArray(mounts))throw fail('invalid-shared2-server-catalog');
 if(previous&&(previous.account!==scope.account||previous.workspace!==scope.workspace))throw fail('shared2-previous-scope-mismatch');
 const server=new Map(),attachments=new Map(),folders=[];
 for(const row of catalog.folders){if(!row||typeof row.id!=='string'||server.has(row.id))throw fail('invalid-shared2-server-catalog');server.set(row.id,row);}
 for(const mount of mounts){if(!mount||!(/^[a-f0-9]{32}$/).test(mount.folder)||attachments.has(mount.folder)||mount.accepted!==true)throw fail('invalid-shared2-local-attachment');attachments.set(mount.folder,mount);}
 for(const mount of attachments.values()){
  const row=server.get(mount.folder),old=previous?.folders.find(row=>row.id===mount.folder);
  if(!row){if(old)folders.push({...old,phase:'revoked'});else throw fail('shared2-attachment-not-authorized');continue;}
  if(old&&old.mount!==mount.mount)throw fail('shared2-mount-move-handshake-required');
  // Reappearance of membership must not silently reactivate a revoked mount.
  if(old?.phase==='revoked'&&mount.acceptedRevision!==row.revision){folders.push({...old,phase:'revoked'});continue;}
  folders.push({id:row.id,database:row.database,generation:row.generation,revision:row.revision,role:row.role,encrypted:row.encrypted,keyEpoch:row.keyEpoch,documentRoot:row.documentRoot,mount:mount.mount,phase:'active'});
 }
 for(const old of previous?.folders||[])if(!attachments.has(old.id))folders.push({...old,phase:'revoked'});
 return routingSnapshot({protocol:2,...scope,revision:catalog.revision,personal,folders},scope);
}

/** request is the host's authenticated HTTP adapter (including token refresh).
 * getSession never persists a token in the routing catalog/local engine config.
 */
export function createShared2CatalogClient({request,getSession}){
 if(typeof request!=='function'||typeof getSession!=='function')throw fail('shared2-session-adapter-required');
 async function call(path){
  const session=await getSession();
  if(!session||typeof session.accessToken!=='string'||!session.accessToken||/[\s\x00-\x1f\x7f]/.test(session.accessToken))throw fail('shared2-session-unavailable');
  const token=session.accessToken;
  const response=await request(path,{method:'GET',headers:{Authorization:'Bearer '+token}});
  if(response.status!==200||!response.json||typeof response.json!=='object')throw fail('shared2-control-request-rejected');
  const used=response.sessionToken||token;if(typeof used!=='string'||!used||/[\s\x00-\x1f\x7f]/.test(used))throw fail('shared2-invalid-session-token');
  return {data:response.json,token:used};
 }
 return {
  async catalog(){return (await call('/shared2/catalog')).data;},
  async resolveAccess(profile){
   if(!profile||!(/^[a-f0-9]{32}$/).test(profile.folder))throw fail('invalid-shared2-folder');
   const {data,token}=await call('/shared2/folders/'+profile.folder+'/grant');
   for(const key of ['account','folder','database','generation','revision','role'])if(data[key]!==profile[key])throw fail('shared2-grant-mismatch');
   for(const key of ['authorityEpoch','membershipEpoch'])if(profile[key]!==undefined&&data[key]!==profile[key])throw fail('shared2-grant-mismatch');
   return {...profile,token};
  },
 };
}
