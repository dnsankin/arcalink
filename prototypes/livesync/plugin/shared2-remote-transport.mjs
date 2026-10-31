const fail=code=>Object.assign(Error(code),{code});
/** Scoped fetch for a future authenticated shared2 gateway, not direct CouchDB.
 * Credentials are obtained again for every HTTP request. Local abort is not a
 * distributed write fence; the gateway must validate these claims itself.
 */
function createScopedRemoteTransport({origin,profile,resolveAccess,fetch:send=globalThis.fetch,allowLocalTest=false,gatewayPath='/shared2/couch/'},privateRead,privateTarget=false){
 const base=new URL(origin),p=Object.freeze({...profile});
 if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||!(base.protocol==='https:'||(allowLocalTest===true&&base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw fail('invalid-shared2-gateway-origin');
 const integer=n=>Number.isSafeInteger(n)&&n>=0;
 const aliasPrivate=/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/alias-namespaces\/[a-f0-9]{32}\/(?:source|private)\/couch\/$/.test(gatewayPath),aliasShared=/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/alias-namespaces\/[a-f0-9]{32}\/(?:sharedSource|shared)\/couch\/$/.test(gatewayPath);
 if(![p.account,p.workspace].every(v=>typeof v==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v))||p.kind!==(privateRead||privateTarget?'personal':'shared')||!/^[a-f0-9]{32}$/.test(p.folder)||!(privateRead||privateTarget?/^arcalink_p_[a-f0-9]{32}$/:/^arcalink_s_[a-f0-9]{32}$/).test(p.database)||privateRead&&(typeof p.encrypted!=='boolean'||p.role!=='viewer'||p.encrypted!==true&&!aliasPrivate&&!/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/reverse-namespaces\/[a-f0-9]{32}\/source\/couch\/$/.test(gatewayPath))||privateTarget&&(typeof p.encrypted!=='boolean'||!integer(p.keyEpoch)||p.encrypted!==(p.keyEpoch>0)||!['owner','viewer'].includes(p.role))||!integer(p.generation)||p.generation<1||!integer(p.revision)||!integer(p.catalogRevision)||!['owner','editor','viewer'].includes(p.role)||typeof resolveAccess!=='function'||typeof send!=='function')throw fail('invalid-shared2-remote-profile');
 if(typeof gatewayPath!=='string'||!(privateRead?(aliasPrivate||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/encrypted-namespaces\/[a-f0-9]{32}\/(?:source|private)\/couch\/$/.test(gatewayPath)||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/reverse-namespaces\/[a-f0-9]{32}\/(?:source|target)\/couch\/$/.test(gatewayPath)):privateTarget?/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/reverse-namespaces\/[a-f0-9]{32}\/target\/couch\/$/.test(gatewayPath):(aliasShared||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/couch\/$/.test(gatewayPath)||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/device-jobs\/[a-f0-9]{32}\/(?:source|target)\/couch\/$/.test(gatewayPath)||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/encrypted-namespaces\/[a-f0-9]{32}\/shared\/couch\/$/.test(gatewayPath)||/^\/(?:[A-Za-z0-9_-]+\/)*shared2\/reverse-namespaces\/[a-f0-9]{32}\/shared\/couch\/$/.test(gatewayPath))))throw fail('invalid-shared2-gateway-path');
 const databaseURL=new URL(gatewayPath+p.database+'/',base).href,pending=new Set(),controllers=new Set();let closed=false;
 const bound=['account','workspace','folder','database','generation','revision','catalogRevision','role'];
 async function request(input,options={}){
  if(closed)throw fail('shared2-remote-closed');
  if(typeof input!=='string'&&!(input instanceof URL))throw fail('shared2-request-url-required');
  const url=new URL(input),root=databaseURL.slice(0,-1);
  if(url.username||url.password||url.hash||url.origin!==base.origin||!(url.pathname===new URL(root).pathname||url.href.startsWith(databaseURL)))throw fail('shared2-remote-scope-mismatch');
  if(privateRead){const method=options.method||'GET';let tail;try{tail=decodeURIComponent(url.pathname.slice(new URL(root).pathname.length+1));}catch{throw fail('shared2-private-source-read-only');}if(!['GET','HEAD','POST'].includes(method)||method==='POST'&&!['_all_docs','_changes','_bulk_get','_revs_diff'].includes(tail))throw fail('shared2-private-source-read-only');}
  if(privateTarget){
   const method=options.method||'GET';let tail;try{tail=decodeURIComponent(url.pathname.slice(new URL(root).pathname.length+1));}catch{throw fail('shared2-private-target-scope');}
   const read=['GET','HEAD'].includes(method)||method==='POST'&&['_all_docs','_changes','_bulk_get','_revs_diff'].includes(tail);
   const write=method==='POST'&&tail==='_bulk_docs'||['PUT','DELETE'].includes(method)&&!!tail&&!tail.startsWith('_');
   if(!read&&(!write||p.role!=='owner'))throw fail('shared2-private-target-scope');
  }
  const controller=new AbortController();controllers.add(controller);
  const external=options.signal,onAbort=()=>controller.abort();if(external?.aborted)controller.abort();else external?.addEventListener('abort',onAbort,{once:true});
  try{
   const grant=await resolveAccess(p);
   if(closed||controller.signal.aborted)throw fail('shared2-remote-closed-or-aborted');
   if(!grant||bound.some(key=>grant[key]!==p[key])||typeof grant.token!=='string'||!grant.token||/[\s\x00-\x1f\x7f]/.test(grant.token))throw fail('shared2-remote-access-denied');
   const headers=new Headers(options.headers);headers.delete('Cookie');headers.delete('Proxy-Authorization');headers.set('Authorization','Bearer '+grant.token);
   headers.set('X-ArcaLink-Folder',p.folder);headers.set('X-ArcaLink-Generation',String(p.generation));
   headers.set('X-ArcaLink-Catalog-Revision',String(p.catalogRevision));headers.set('X-ArcaLink-Folder-Revision',String(p.revision));
   // Redirects and ambient browser cookies must not carry the scoped credential.
   const response=await send(url.href,{...options,headers,redirect:'error',credentials:'omit',signal:controller.signal});
   let stale=false;
   if(response.status===409){try{const body=await response.clone().json();stale=['shared2-stale-lease','shared2-source-fenced','shared2-not-active'].includes(body.error);}catch{stale=true;}}
   if(response.status===401||response.status===403||stale){closed=true;for(const other of controllers)other.abort();throw fail('shared2-remote-authority-rejected');}
   return response;
  }finally{controllers.delete(controller);external?.removeEventListener('abort',onAbort);}
 }
 function fetch(input,options){const task=request(input,options);pending.add(task);task.then(()=>pending.delete(task),()=>pending.delete(task));return task;}
 async function close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...pending]);}
 return {url:databaseURL.slice(0,-1),fetch,close};
}

export const createShared2RemoteTransport=options=>createScopedRemoteTransport(options,false);
export const createShared2PrivateRemoteTransport=options=>createScopedRemoteTransport(options,true);

/** Adapter for the pinned PouchDB HTTP constructor. skip_setup prevents clients
 * from provisioning a database; only the trusted migration worker may do that.
 */
export function createShared2RemoteFactory({createPouchDB,configureEncryption,...options}){
 if(typeof createPouchDB!=='function')throw fail('shared2-remote-database-factory-required');
 return async profile=>{
  const transport=createShared2RemoteTransport({...options,profile});let database;
  try{database=createPouchDB(transport.url,{fetch:transport.fetch,skip_setup:true});if(typeof database?.close!=='function')throw fail('invalid-shared2-remote-database');if(profile.encrypted){if(typeof configureEncryption!=='function')throw fail('shared2-encrypted-remote-not-ready');await configureEncryption(database,profile);}}
  catch(error){await transport.close();if(database)await database.close().catch(()=>{});throw error;}
  let closed=false,closing;
  return {database,close(){if(closed)return Promise.resolve();if(closing)return closing;closing=(async()=>{await transport.close();await database.close();closed=true;})().finally(()=>{closing=null;});return closing;}};
 };
}

/** @param {{createPouchDB:Function,configureDecryption?:Function,raw?:boolean,origin:string,resolveAccess:Function,fetch?:Function,allowLocalTest?:boolean,gatewayPath:string}} options */
export function createShared2PrivateRemoteFactory({createPouchDB,configureDecryption=undefined,raw=false,...options}){
 if(typeof createPouchDB!=='function'||typeof raw!=='boolean')throw fail('shared2-private-cipher-adapter-required');
 return async profile=>{
  const transport=createShared2PrivateRemoteTransport({...options,profile});let database;
  try{database=createPouchDB(transport.url,{fetch:transport.fetch,skip_setup:true});if(typeof database?.close!=='function')throw fail('invalid-shared2-remote-database');if(!raw&&profile.encrypted){if(typeof configureDecryption!=='function')throw fail('shared2-private-cipher-adapter-required');await configureDecryption(database,profile);}}
  catch(error){await transport.close();if(database)await database.close().catch(()=>{});throw error;}
  let closed=false,closing;
  return {database,close(){if(closed)return Promise.resolve();if(closing)return closing;closing=(async()=>{await transport.close();await database.close();closed=true;})().finally(()=>{closing=null;});return closing;}};
 };
}

/** Explicit reverse-only P1 transport. Never enables writes on P0/read source. */
export const createShared2PrivateTargetTransport=options=>createScopedRemoteTransport(options,false,true);
export function createShared2PrivateTargetRemoteFactory({createPouchDB,configureEncryption,raw=false,...options}){
 if(typeof createPouchDB!=='function'||typeof raw!=='boolean')throw fail('shared2-private-cipher-adapter-required');
 return async profile=>{
  const transport=createShared2PrivateTargetTransport({...options,profile});let database;
  try{database=createPouchDB(transport.url,{fetch:transport.fetch,skip_setup:true});if(typeof database?.close!=='function')throw fail('invalid-shared2-remote-database');if(profile.encrypted&&!raw){if(typeof configureEncryption!=='function')throw fail('shared2-private-cipher-adapter-required');await configureEncryption(database,profile);}}
  catch(error){await transport.close();if(database)await database.close().catch(()=>{});throw error;}
  let closed=false,closing;return {database,close(){if(closed)return Promise.resolve();if(closing)return closing;closing=(async()=>{await transport.close();await database.close();closed=true;})().finally(()=>{closing=null;});return closing;}};
 };
}
