import test from 'node:test';import assert from 'node:assert/strict';
import {composeShared2Snapshot,createShared2CatalogClient} from '../plugin/shared2-catalog-client.mjs';
const scope={account:'alice',workspace:'local-work'};const personal={database:'arcalink_p_'+'c'.repeat(32),generation:1};
const row={id:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,revision:1,documentRoot:'Owner/Team',role:'editor',encrypted:false,keyEpoch:0};
const catalog={protocol:2,account:'alice',revision:2,folders:[row]};const mount={folder:row.id,mount:'Local/Shared',accepted:true};
const compose=extra=>composeShared2Snapshot({catalog,scope,personal,mounts:[mount],...extra});
test('membership alone does not attach local files and explicit mount retains owner document root',()=>{
 assert.equal(compose({mounts:[]}).folders.length,0);const snapshot=compose();assert.equal(snapshot.folders[0].mount,'Local/Shared');assert.equal(snapshot.folders[0].documentRoot,'Owner/Team');
});
test('revoked membership or removed local attachment cannot fall through to private sync',()=>{
 const previous=compose();const removed=compose({catalog:{...catalog,revision:3,folders:[]},previous});assert.equal(removed.folders[0].phase,'revoked');assert.equal(removed.folders[0].mount,mount.mount);
 assert.equal(compose({mounts:[],previous,catalog:{...catalog,revision:3}}).folders[0].phase,'revoked');
});
test('revoked mounts require explicit acceptance at current revision before activation',()=>{
 const previous=compose();previous.folders[0].phase='revoked';const nextCatalog={...catalog,revision:3,folders:[{...row,revision:2}]};
 assert.equal(compose({previous,catalog:nextCatalog}).folders[0].phase,'revoked');assert.equal(compose({previous,catalog:nextCatalog,mounts:[{...mount,acceptedRevision:2}]}).folders[0].phase,'active');
});
test('wrong identity, duplicate rows, unauthorised attachment and mount moves are rejected',()=>{
 for(const extra of [{catalog:{...catalog,account:'bob'}},{catalog:{...catalog,folders:[row,row]}},{catalog:{...catalog,folders:[]}},{previous:compose(),mounts:[{...mount,mount:'Moved'}]}])assert.throws(()=>compose(extra));
});
test('catalog and grants use refreshed session without persisting or trusting claimed account',async()=>{
 let token='first',calls=[];const profile={account:'alice',folder:row.id,database:row.database,generation:1,revision:1,role:'editor',workspace:scope.workspace,catalogRevision:2};
 const client=createShared2CatalogClient({getSession:async()=>({accessToken:token}),request:async(path,options)=>{calls.push({path,options});return {status:200,json:path==='/shared2/catalog'?catalog:{...profile,device:'device'}}}});
 assert.deepEqual(await client.catalog(),catalog);token='second';assert.equal((await client.resolveAccess(profile)).token,'second');assert.equal(calls[1].options.headers.Authorization,'Bearer second');assert.equal('token' in compose(),false);
});
test('failed or mismatched grant never authorizes a remote request',async()=>{
 const profile={account:'alice',folder:row.id,database:row.database,generation:1,revision:1,role:'editor'};
 const client=createShared2CatalogClient({getSession:async()=>({accessToken:'test'}),request:async()=>({status:200,json:{...profile,generation:2}})});await assert.rejects(client.resolveAccess(profile),/grant-mismatch/);
});

test('grant retains exactly the session token used for its identity verification',async()=>{
 const session={accessToken:'old-session'},profile={account:'alice',folder:row.id,database:row.database,generation:1,revision:1,role:'editor'};
 const client=createShared2CatalogClient({getSession:async()=>session,request:async()=>{session.accessToken='different-session';return {status:200,json:profile}}});
 assert.equal((await client.resolveAccess(profile)).token,'old-session');
});
