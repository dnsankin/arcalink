import test from 'node:test';import assert from 'node:assert/strict';
import {routingSnapshot,createShared2Router} from '../plugin/shared2-routing.mjs';
import {createFolderPolicyStore} from '../plugin/folder-policy-store.mjs';
const scope={account:'alice',workspace:'work'};
const folder={id:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,revision:0,mount:'Shared/Team',documentRoot:'Owner/Team',role:'editor',phase:'active',encrypted:false,keyEpoch:0};
const snapshot=()=>({protocol:2,...scope,revision:1,personal:{database:'arcalink_p_'+'c'.repeat(32),generation:1},folders:[{...folder}]});
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const disk=new Map(),events=[];const adapter={exists:async p=>disk.has(p),read:async p=>disk.get(p),write:async(p,data)=>{disk.set(p,data)}};
 const store=createFolderPolicyStore(adapter,'shared2-test');
 const connector={ready:async()=>{},read:async route=>{events.push(['read',route]);return 'bytes'},write:async(route,value)=>events.push(['write',route,value])};
 const quiesce=async()=>{};return {disk,events,adapter,store,connector,quiesce,router:createShared2Router({store,scope,connector,quiesce})};
}

test('shared paths route only to shared DB while siblings remain personal',async()=>{
 const x=fixture();await x.router.apply(snapshot());await x.router.write('Shared/Team/a.md','data');await x.router.write('Shared/Team-other/a.md','other');
 assert.equal(x.events[0][1].database,folder.database);assert.equal(x.events[0][1].path,'Owner/Team/a.md');assert.equal(x.events[0][1].relative,'a.md');assert.equal(x.events[1][1].kind,'personal');assert.equal(x.events.length,2);
});
test('reader, migrating and missing-key routes fail without private fallback',async()=>{
 for(const change of [{role:'viewer'},{phase:'migrating'},{encrypted:true,keyEpoch:1}]){
  const x=fixture(),s=snapshot();Object.assign(s.folders[0],change);await x.router.apply(s);
  await assert.rejects(x.router.write('Shared/Team/a.md','data'));assert.deepEqual(x.events,[]);
 }
 const x=fixture(),s=snapshot();s.folders[0].encrypted=true;s.folders[0].keyEpoch=2;
 const router=createShared2Router({...x,scope,keysReady:(id,epoch)=>id===folder.id&&epoch===2});await router.apply(s);await router.write('Shared/Team/a.md','encrypted');assert.equal(x.events[0][1].keyEpoch,2);
});
test('catalog validates tenant, mount boundaries, identities and generation metadata',()=>{
 for(const mutate of [s=>s.account='bob',s=>s.workspace='other',s=>s.folders.push({...folder,id:'d'.repeat(32),mount:'SHARED/team/child',database:'arcalink_s_'+'e'.repeat(32)}),s=>s.folders[0].mount='../bad',s=>s.folders[0].generation=0,s=>s.folders[0].keyEpoch=1,s=>s.folders[0].role='admin']){
  const s=snapshot();mutate(s);assert.throws(()=>routingSnapshot(s,scope));
 }
});
test('pending connection cannot write through old routing during catalog switch',async()=>{
 const x=fixture();await x.router.apply(snapshot());let release;x.connector.ready=()=>new Promise(r=>release=r);
 const writing=x.router.write('Shared/Team/a.md','stale');await new Promise(r=>setImmediate(r));
 const s=snapshot();s.revision++;s.folders[0].generation++;const switching=x.router.apply(s);await new Promise(r=>setImmediate(r));
 release();await assert.rejects(writing,/switching/);await switching;assert.equal(x.events.length,0);assert.equal(x.router.route('Shared/Team/a.md').generation,2);
});
test('already dispatched write drains before persistence and quiesce',async()=>{
 const x=fixture();await x.router.apply(snapshot());let release,started=false;x.connector.write=()=>{started=true;return new Promise(r=>release=r)};
 const writing=x.router.write('Shared/Team/a.md','data');while(!started)await new Promise(r=>setImmediate(r));
 const s=snapshot();s.revision++;const switching=x.router.apply(s);await new Promise(r=>setImmediate(r));
 assert.equal(x.router.state().updating,true);assert.equal(x.router.state().catalog.revision,1);release('ok');assert.equal(await writing,'ok');await switching;assert.equal(x.router.state().catalog.revision,2);
});
test('failed persistence pauses routes and retry recovers without guessing authority',async()=>{
 const x=fixture();await x.router.apply(snapshot());const original=x.adapter.write;x.adapter.write=async()=>{throw Error('disk full')};const s=snapshot();s.revision++;
 await assert.rejects(x.router.apply(s),/disk full/);await assert.rejects(x.router.write('Private/a.md','x'),/paused/);assert.equal(x.events.length,0);
 x.adapter.write=original;await x.router.apply(s);assert.equal(x.router.state().ready,true);
});
test('restart reloads durable catalog; absent/corrupt state does not route personal by default',async()=>{
 const x=fixture();await assert.rejects(x.router.read('Private/a.md'),/not-ready/);await x.router.apply(snapshot());
 const restarted=createShared2Router({...x,scope});await restarted.load();assert.equal(restarted.route('Shared/Team/a.md').kind,'shared');
 for(const path of x.disk.keys())x.disk.set(path,'corrupt');const broken=createShared2Router({...x,scope});await assert.rejects(broken.load());await assert.rejects(broken.read('Private/a.md'),/paused/);
});
test('conflicting same revision and stale generation cannot replace accepted state',async()=>{
 const x=fixture();await x.router.apply(snapshot());const s=snapshot();s.folders[0].database='arcalink_s_'+'d'.repeat(32);
 await assert.rejects(x.router.apply(s),/stale/);assert.equal(x.router.state().catalog.folders[0].database,folder.database);
 await x.router.apply(snapshot());assert.equal(x.router.state().ready,true);
});
test('server rejection is propagated without fallback or implicit retries',async()=>{
 const x=fixture();await x.router.apply(snapshot());let writes=0;x.connector.write=async route=>{writes++;assert.equal(route.kind,'shared');throw Error('stale server generation')};
 await assert.rejects(x.router.write('Shared/Team/a.md','x'),/stale server/);assert.equal(writes,1);
});
test('catalog input and returned state cannot mutate installed routing',async()=>{
 const x=fixture(),s=snapshot(),pending=x.router.apply(s);s.folders[0].mount='Other';await pending;
 const view=x.router.state();view.catalog.folders[0].mount='Changed';assert.equal(x.router.route('Shared/Team/a.md').kind,'shared');
});
test('newer catalog revision cannot downgrade folder or personal generation',async()=>{
 for(const mutate of [s=>s.folders[0].generation=1,s=>s.folders[0].keyEpoch=1,s=>s.personal.generation=1,s=>{s.folders[0].database='arcalink_s_'+'d'.repeat(32);s.folders[0].generation=2}]){
  const x=fixture(),s=snapshot();s.folders[0].generation=2;s.folders[0].encrypted=true;s.folders[0].keyEpoch=2;s.personal.generation=2;await x.router.apply(s);
  const next=clone(s);next.revision++;mutate(next);await assert.rejects(x.router.apply(next),/generation/);
 }
});
test('removed or revoked mount never silently becomes a private write',async()=>{
 const x=fixture();await x.router.apply(snapshot());const s=snapshot();s.revision++;s.folders=[];
 await assert.rejects(x.router.apply(s),/handshake/);await assert.rejects(x.router.write('Shared/Team/a.md','x'),/paused/);
 const revoked=snapshot();revoked.revision=2;revoked.folders[0].phase='revoked';await x.router.apply(revoked);await assert.rejects(x.router.write('Shared/Team/a.md','x'),/revoked/);assert.equal(x.events.length,0);
});
test('async or truthy key readiness cannot bypass missing-key guard',async()=>{
 const x=fixture(),s=snapshot();s.folders[0].encrypted=true;s.folders[0].keyEpoch=1;
 for(const keysReady of [()=>Promise.resolve(false),()=>1]){
  const router=createShared2Router({...x,scope,keysReady});await router.apply(s);await assert.rejects(router.write('Shared/Team/a.md','x'),/key-unavailable/);
 }
});
test('catalog load and install are serialized and caller scope mutation is isolated',async()=>{
 const x=fixture();await x.router.apply(snapshot());let release;const store={...x.store,read:()=>new Promise(r=>release=r)};
 const mutableScope={...scope};const router=createShared2Router({...x,scope:mutableScope,store});mutableScope.account='bob';
 const loading=router.load();await new Promise(r=>setImmediate(r));const next=snapshot();next.revision=2;const installing=router.apply(next);release(snapshot());await loading;await installing;assert.equal(router.state().catalog.revision,2);assert.equal(router.state().catalog.account,'alice');
});
