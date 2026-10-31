import test from 'node:test';import assert from 'node:assert/strict';
import {createShared2EnginePool} from '../plugin/shared2-engine-pool.mjs';
import {createShared2Router} from '../plugin/shared2-routing.mjs';
const lease=(extra={})=>({account:'alice',workspace:'work',kind:'shared',folder:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,revision:0,catalogRevision:1,keyEpoch:0,encrypted:false,role:'editor',path:'Team/a.md',...extra});
function fixture(){const created=[],events=[];const factory=async config=>{const engine={read:async path=>{events.push(['read',config.database,path]);return 'data'},write:async(path,value)=>events.push(['write',config.database,path,value]),close:async()=>events.push(['close',config.database])};created.push({config,engine});return engine};const pool=createShared2EnginePool({openEngine:factory,accessCheck:async()=>true});return {pool,created,events,factory};}

test('same namespace shares one opening; personal/shared generations and accounts are isolated',async()=>{
 const x=fixture();await Promise.all([x.pool.ready(lease()),x.pool.ready(lease({path:'Team/b.md'}))]);assert.equal(x.created.length,1);
 await x.pool.ready(lease({generation:2}));await x.pool.ready(lease({account:'bob'}));await x.pool.ready({account:'alice',workspace:'work',kind:'personal',database:'arcalink_p_'+'c'.repeat(32),generation:1,catalogRevision:1,path:'private.md'});assert.equal(x.created.length,4);
 assert.equal('path' in x.created[0].config,false);await x.pool.write(lease(),'bytes');assert.deepEqual(x.events[0],['write',lease().database,'Team/a.md','bytes']);
});
test('access is rechecked per operation and rejects without fallback',async()=>{
 const x=fixture();let accepted=true;const pool=createShared2EnginePool({openEngine:x.factory,accessCheck:async()=>accepted});await pool.ready(lease());accepted=false;
 await assert.rejects(pool.write(lease(),'x'),/access-denied/);assert.equal(x.events.length,0);
 await assert.rejects(x.pool.write(lease({role:'viewer'}),'x'),/read-only/);
});
test('quiesce waits for opening then closes late engine and rejects old readiness',async()=>{
 let release,closed=0;const pool=createShared2EnginePool({accessCheck:async()=>true,openEngine:()=>new Promise(r=>release=r)});
 const opening=pool.ready(lease());while(!release)await new Promise(r=>setImmediate(r));const closing=pool.quiesce();
 release({read:async()=>{},write:async()=>{},close:async()=>closed++});await assert.rejects(opening,/paused|stale/);await closing;assert.equal(closed,1);assert.equal(pool.state().engines,0);
});
test('quiesce drains writes and closes old engine before a new namespace opens',async()=>{
 const x=fixture();await x.pool.ready(lease());let release,started=false;x.created[0].engine.write=()=>{started=true;return new Promise(r=>release=r)};
 const writing=x.pool.write(lease(),'x');while(!started)await new Promise(r=>setImmediate(r));const closing=x.pool.quiesce();assert.equal(x.pool.state().paused,true);
 release('ok');await writing;await closing;assert.equal(x.events[0][0],'close');await x.pool.ready(lease({generation:2}));assert.equal(x.created.length,2);
});
test('failed close pauses the pool until successful explicit recovery',async()=>{
 const x=fixture();await x.pool.ready(lease());let fail=true;x.created[0].engine.close=async()=>{if(fail)throw Error('close failed')};
 await assert.rejects(x.pool.quiesce(),/close failed/);await assert.rejects(x.pool.ready(lease()),/paused/);fail=false;await x.pool.quiesce();assert.equal(x.pool.state().paused,false);
});
test('factory failure never adopts another scope and dispose prevents reopen',async()=>{
 const x=fixture();let failed=true;const pool=createShared2EnginePool({accessCheck:async()=>true,openEngine:async config=>{if(failed)throw Error('open failed');return x.factory(config)}});
 await assert.rejects(pool.ready(lease()),/open failed/);failed=false;await pool.ready(lease());await pool.dispose();assert.equal(pool.state().engines,0);await assert.rejects(pool.ready(lease()),/paused/);
});
test('router/pool integration retires generation before subsequent write',async()=>{
 const x=fixture();let saved={};const store={read:async()=>saved,update:async change=>{saved=await change(saved)}};
 const router=createShared2Router({store,scope:{account:'alice',workspace:'work'},connector:x.pool,quiesce:()=>x.pool.quiesce()});
 const snapshot={protocol:2,account:'alice',workspace:'work',revision:1,personal:{database:'arcalink_p_'+'c'.repeat(32),generation:1},folders:[{id:'a'.repeat(32),database:lease().database,generation:1,revision:0,mount:'Local',documentRoot:'Owner',role:'editor',phase:'active',encrypted:false,keyEpoch:0}]};
 await router.apply(snapshot);await router.write('Local/a.md','first');const next=structuredClone(snapshot);next.revision=2;next.folders[0].generation=2;next.folders[0].revision=1;await router.apply(next);await router.write('Local/a.md','second');
 assert.deepEqual(x.events.map(e=>e[0]),['write','close','write']);assert.equal(x.created[1].config.generation,2);assert.equal(x.events[2][2],'Owner/a.md');
});
test('mutable caller lease cannot change path or generation after admission starts',async()=>{
 const x=fixture();let release;const pool=createShared2EnginePool({openEngine:x.factory,accessCheck:()=>new Promise(r=>release=r)});
 const request=lease(),opening=pool.ready(request);while(!release)await new Promise(r=>setImmediate(r));request.generation=99;request.path='Changed';release(true);await opening;
 assert.equal(x.created[0].config.generation,1);
});
test('invalid closeable engine is retired rather than leaked',async()=>{
 let closed=0;const pool=createShared2EnginePool({accessCheck:async()=>true,openEngine:async()=>({close:async()=>closed++})});
 await assert.rejects(pool.ready(lease()),/invalid-shared2-engine/);assert.equal(closed,1);assert.equal(pool.state().engines,0);
});
test('operations submitted during retirement reject immediately',async()=>{
 const x=fixture();await x.pool.ready(lease());let release;x.created[0].engine.close=()=>new Promise(r=>release=r);
 const closing=x.pool.quiesce();while(!release)await new Promise(r=>setImmediate(r));
 const opening=x.pool.ready(lease());release();await closing;await assert.rejects(opening,/paused/);assert.equal(x.created.length,1);
});
test('catalog retirement drains in-progress replication before closing engine',async()=>{
 const x=fixture();await x.pool.ready(lease());let release;const events=[];x.created[0].engine.synchronize=()=>new Promise(r=>release=()=>{events.push('replicated');r()});x.created[0].engine.close=async()=>events.push('closed');
 const task=x.pool.synchronize(lease());while(!release)await new Promise(r=>setImmediate(r));const close=x.pool.quiesce();assert.deepEqual(events,[]);release();await task;await close;assert.deepEqual(events,['replicated','closed']);
});
