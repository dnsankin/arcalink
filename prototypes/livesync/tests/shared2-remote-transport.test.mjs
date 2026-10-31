import test from 'node:test';import assert from 'node:assert/strict';
import {createShared2RemoteTransport,createShared2PrivateTargetTransport,createShared2PrivateRemoteTransport} from '../plugin/shared2-remote-transport.mjs';
const profile={kind:'shared',account:'alice',workspace:'work',folder:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,revision:2,catalogRevision:3,role:'editor'};
function fixture(extra={}){const calls=[];let checks=0;const transport=createShared2RemoteTransport({origin:'https://stand.invalid',profile,resolveAccess:async p=>{checks++;return {...p,token:'test-token'}},fetch:async(url,options)=>{calls.push({url,options});return new Response('{}')},...extra});return {transport,calls,checks:()=>checks};}
test('each request refreshes scoped authority and overrides caller credentials',async()=>{
 const x=fixture();await x.transport.fetch(x.transport.url+'/_changes?since=0',{headers:{Authorization:'Basic wrong'},credentials:'include',redirect:'follow'});await x.transport.fetch(x.transport.url);
 assert.equal(x.checks(),2);const opts=x.calls[0].options;assert.equal(opts.headers.get('Authorization'),'Bearer test-token');assert.equal(opts.headers.get('X-ArcaLink-Generation'),'1');assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');await x.transport.close();
});
test('cross-origin, adjacent database and encoded traversal never send credentials',async()=>{
 const x=fixture();for(const url of ['https://other.invalid/'+profile.database,x.transport.url+'-other/_changes',x.transport.url+'/%2e%2e/_all_dbs',x.transport.url+'/#secret'])await assert.rejects(x.transport.fetch(url));assert.equal(x.calls.length,0);assert.equal(x.checks(),0);
});
test('stale authority, role and scope fail before network',async()=>{
 for(const change of [{generation:2},{account:'bob'},{role:'owner'},{revision:99},{token:'bad\nvalue'}]){const x=fixture({resolveAccess:async p=>({...p,token:'test',...change})});await assert.rejects(x.transport.fetch(x.transport.url),/access-denied/);assert.equal(x.calls.length,0);}
});
test('close during admission prevents late request dispatch',async()=>{
 let release;const x=fixture({resolveAccess:p=>new Promise(r=>release=()=>r({...p,token:'test'}))});const task=x.transport.fetch(x.transport.url);const close=x.transport.close();release();await assert.rejects(task,/closed/);await close;assert.equal(x.calls.length,0);await assert.rejects(x.transport.fetch(x.transport.url),/closed/);
});
test('authority rejection aborts concurrent requests and permanently stops this transport',async()=>{
 let waiting,aborted=false;const x=fixture({fetch:async(url,opts)=>{if(url.endsWith('/_changes'))return new Response('{}',{status:403});return new Promise((resolve,reject)=>{waiting=true;opts.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'))},{once:true})})}});
 const task=x.transport.fetch(x.transport.url);while(!waiting)await new Promise(r=>setImmediate(r));await assert.rejects(x.transport.fetch(x.transport.url+'/_changes'),/authority-rejected/);await assert.rejects(task,/aborted/);assert.equal(aborted,true);await assert.rejects(x.transport.fetch(x.transport.url),/closed/);
});
test('only explicit loopback tests allow HTTP and origins cannot embed credentials',()=>{
 for(const origin of ['http://stand.invalid','https://user:password@stand.invalid','https://stand.invalid/path','https://stand.invalid/?x=1'])assert.throws(()=>fixture({origin}));const x=fixture({origin:'http://127.0.0.1:1234',allowLocalTest:true});assert.match(x.transport.url,/127.0.0.1/);
});

test('remote PouchDB factory disables provisioning and closes transport/database',async()=>{
 const {createShared2RemoteFactory}=await import('../plugin/shared2-remote-transport.mjs');let options,url,closed=0;
 const factory=createShared2RemoteFactory({origin:'https://stand.invalid',resolveAccess:async p=>({...p,token:'test'}),createPouchDB:(u,o)=>{url=u;options=o;return {close:async()=>closed++}}});
 const remote=await factory(profile);assert.equal(options.skip_setup,true);assert.match(url,/shared2\/couch\/arcalink_s_/);await remote.close();await remote.close();assert.equal(closed,1);await assert.rejects(options.fetch(url),/closed/);
});

test('real HTTP request carries scoped headers and refuses server redirects',async()=>{
 const {createServer}=await import('node:http');const received=[];
 const server=createServer((req,res)=>{received.push({url:req.url,headers:req.headers});if(req.url.endsWith('/redirect')){res.writeHead(302,{Location:'/elsewhere'});res.end();}else{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const transport=createShared2RemoteTransport({origin,allowLocalTest:true,profile,resolveAccess:async p=>({...p,token:'test-token'})});
 try{const response=await transport.fetch(transport.url+'/_changes?since=0',{headers:{Cookie:'personal-session=test',Authorization:'Basic wrong'}});assert.deepEqual(await response.json(),{ok:true});assert.equal(received[0].headers.authorization,'Bearer test-token');assert.equal(received[0].headers.cookie,undefined);assert.equal(received[0].headers['x-arcalink-folder'],profile.folder);await assert.rejects(transport.fetch(transport.url+'/redirect'));assert.equal(received.length,2);}
 finally{await transport.close();await new Promise(r=>server.close(r));}
});

test('ordinary document conflicts retain transport but stale gateway authority stops it',async()=>{
 const conflict=fixture({fetch:async()=>new Response('{"error":"conflict"}',{status:409})});assert.equal((await conflict.transport.fetch(conflict.transport.url+'/file')).status,409);assert.equal((await conflict.transport.fetch(conflict.transport.url+'/file')).status,409);await conflict.transport.close();
 const stale=fixture({fetch:async()=>new Response('{"error":"shared2-stale-lease"}',{status:409})});await assert.rejects(stale.transport.fetch(stale.transport.url),/authority-rejected/);await assert.rejects(stale.transport.fetch(stale.transport.url),/closed/);
});

test('concurrent shutdown shares one database close and can retry a failed close',async()=>{const {createShared2RemoteFactory}=await import('../plugin/shared2-remote-transport.mjs');let calls=0,release;const factory=createShared2RemoteFactory({origin:'https://stand.invalid',resolveAccess:async p=>({...p,token:'test'}),createPouchDB:()=>({close:()=>{calls++;return calls===1?new Promise(resolve=>release=resolve):Promise.resolve();}})}),remote=await factory(profile),first=remote.close(),second=remote.close();while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();await Promise.all([first,second]);await remote.close();assert.equal(calls,1);
let attempts=0;const retry=await createShared2RemoteFactory({origin:'https://stand.invalid',resolveAccess:async p=>({...p,token:'test'}),createPouchDB:()=>({close:async()=>{if(++attempts===1)throw Error('close failed');}})})(profile);await assert.rejects(retry.close(),/close failed/);await retry.close();assert.equal(attempts,2);});
test('private transports require a job-scoped viewer and refuse writes before admission',async()=>{const {createShared2PrivateRemoteTransport}=await import('../plugin/shared2-remote-transport.mjs');const privateProfile={...profile,kind:'personal',database:'arcalink_p_'+'c'.repeat(32),role:'viewer',encrypted:true},calls=[];let grants=0;const options={origin:'https://stand.invalid',profile:privateProfile,gatewayPath:'/sync/api/shared2/encrypted-namespaces/'+'d'.repeat(32)+'/source/couch/',resolveAccess:async p=>{grants++;return {...p,token:'owner-token'};},fetch:async(url,options)=>{calls.push({url,options});return new Response('{}');}};const transport=createShared2PrivateRemoteTransport(options);for(const [method,path] of [['PUT','/file'],['DELETE','/file'],['POST','/_bulk_docs'],['POST','/_compact']])await assert.rejects(transport.fetch(transport.url+path,{method}),/read-only/);assert.equal(grants,0);await transport.fetch(transport.url+'/_local/obsidian_livesync_sync_parameters');await transport.fetch(transport.url+'/_bulk_get',{method:'POST',body:'{"docs":[]}'});assert.equal(calls.length,2);assert.equal(calls[0].options.headers.get('Authorization'),'Bearer owner-token');for(const change of [{gatewayPath:'/shared2/couch/'},{gatewayPath:'/shared2/encrypted-namespaces/'+'d'.repeat(32)+'/shared/couch/'},{profile:{...privateProfile,role:'owner'}}])assert.throws(()=>createShared2PrivateRemoteTransport({...options,...change}));assert.throws(()=>createShared2RemoteTransport(options));await transport.close();});
test('private factory requires explicit decryption or raw readback and coalesces close',async()=>{const {createShared2PrivateRemoteFactory}=await import('../plugin/shared2-remote-transport.mjs');const p={...profile,kind:'personal',database:'arcalink_p_'+'c'.repeat(32),role:'viewer',encrypted:true};let closes=0,configured=0;const options={origin:'https://stand.invalid',gatewayPath:'/shared2/encrypted-namespaces/'+'d'.repeat(32)+'/private/couch/',resolveAccess:async p=>({...p,token:'test'}),createPouchDB:(_url,settings)=>{assert.equal(settings.skip_setup,true);return {close:async()=>{closes++;}};}};await assert.rejects(createShared2PrivateRemoteFactory(options)(p),/cipher-adapter-required/);const raw=await createShared2PrivateRemoteFactory({...options,raw:true})(p);await Promise.all([raw.close(),raw.close()]);const decrypted=await createShared2PrivateRemoteFactory({...options,configureDecryption:async()=>{configured++;}})(p);await decrypted.close();assert.equal(configured,1);assert.equal(closes,3);});

test('reverse private-target transport cannot become a normal private writer or mutate reserved docs',async()=>{
 const p={...profile,kind:'personal',database:'arcalink_p_'+'c'.repeat(32),encrypted:true,keyEpoch:1,role:'owner'},path='/shared2/reverse-namespaces/'+'d'.repeat(32)+'/target/couch/';let requests=0;
 const options={origin:'https://stand.invalid',profile:p,gatewayPath:path,resolveAccess:async v=>({...v,token:'test-token'}),fetch:async()=>{requests++;return new Response('{}');}},t=createShared2PrivateTargetTransport(options);
 await t.fetch(t.url+'/_bulk_docs',{method:'POST',body:'{"docs":[]}'});await t.fetch(t.url+'/data',{method:'PUT',body:'{}'});assert.equal(requests,2);
 for(const suffix of ['/_local/obsidian_livesync_sync_parameters','/%5Fsecurity','/_design/evil',''])await assert.rejects(t.fetch(t.url+suffix,{method:'PUT',body:'{}'}),/target-scope/);
 for(const gatewayPath of ['/shared2/couch/','/shared2/reverse-namespaces/'+'d'.repeat(32)+'/source/couch/'])assert.throws(()=>createShared2PrivateTargetTransport({...options,gatewayPath}));
 const viewer=createShared2PrivateTargetTransport({...options,profile:{...p,role:'viewer'}});await assert.rejects(viewer.fetch(viewer.url+'/_bulk_docs',{method:'POST',body:'{}'}),/target-scope/);await viewer.close();await t.close();
});
test('plaintext personal reads require explicit reverse or alias scope and never authorize writes',async()=>{
 const p={...profile,kind:'personal',database:'arcalink_p_'+'c'.repeat(32),encrypted:false,keyEpoch:0,role:'viewer'},options={origin:'https://stand.invalid',profile:p,resolveAccess:async v=>({...v,token:'test-token'}),fetch:async()=>new Response('{}')};
 assert.throws(()=>createShared2PrivateRemoteTransport({...options,gatewayPath:'/shared2/encrypted-namespaces/'+'d'.repeat(32)+'/source/couch/'}));
 const t=createShared2PrivateRemoteTransport({...options,gatewayPath:'/shared2/reverse-namespaces/'+'d'.repeat(32)+'/source/couch/'});await t.fetch(t.url+'/data');await assert.rejects(t.fetch(t.url+'/data',{method:'PUT'}),/read-only/);await t.close();
 for(const side of ['source','private']){const t=createShared2PrivateRemoteTransport({...options,gatewayPath:'/sync/api/shared2/alias-namespaces/'+'d'.repeat(32)+'/'+side+'/couch/'});await t.fetch(t.url+'/_bulk_get',{method:'POST',body:'{}'});await assert.rejects(t.fetch(t.url+'/_bulk_docs',{method:'POST',body:'{}'}),/read-only/);await t.close();}
 for(const side of ['sharedSource','shared','target'])assert.throws(()=>createShared2PrivateRemoteTransport({...options,gatewayPath:'/shared2/alias-namespaces/'+'d'.repeat(32)+'/'+side+'/couch/'}));
});
test('alias shared transport permits only its two shared sides and binds every fresh grant',async()=>{
 for(const side of ['sharedSource','shared']){const x=fixture({gatewayPath:'/shared2/alias-namespaces/'+'d'.repeat(32)+'/'+side+'/couch/'});await x.transport.fetch(x.transport.url);assert.equal(x.checks(),1);await x.transport.close();}
 for(const side of ['source','private','target'])assert.throws(()=>fixture({gatewayPath:'/shared2/alias-namespaces/'+'d'.repeat(32)+'/'+side+'/couch/'}));
});
