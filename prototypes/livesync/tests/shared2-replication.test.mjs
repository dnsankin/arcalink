import test from 'node:test';import assert from 'node:assert/strict';
import {createShared2Replication} from '../plugin/shared2-replication.mjs';
const profile={kind:'shared',role:'editor'};
function fixture(extra={}){const calls=[];let closes=0;const database={replicate:{from:(remote,options)=>{calls.push(['pull',options]);return Promise.resolve({ok:true})},to:(remote,options)=>{calls.push(['push',options]);return Promise.resolve({ok:true})}}};const driver=createShared2Replication({database,profile,openRemote:async()=>({database:{},close:async()=>closes++}),accessCheck:async()=>true,...extra});return {driver,calls,closes:()=>closes};}
test('bounded pull then push exclude administrative documents without automatic retries',async()=>{
 const x=fixture();await x.driver.synchronize();assert.deepEqual(x.calls.map(c=>c[0]),['pull','push']);const opts=x.calls[0][1];assert.equal(opts.checkpoint,'target');assert.equal(x.calls[1][1].checkpoint,'source');assert.equal(opts.retry,false);assert.equal(opts.live,false);assert.equal(opts.batches_limit,1);assert.equal(opts.filter({_id:'_design/acl'}),false);assert.equal(opts.filter({_id:'file'}),true);await x.driver.close();assert.equal(x.closes(),1);
});
test('write authority is rechecked after pull and prevents upload when revoked',async()=>{
 const modes=[];const x=fixture({accessCheck:async(p,mode)=>{modes.push(mode);return mode!=='write'}});await assert.rejects(x.driver.synchronize(),/access-denied/);assert.deepEqual(x.calls.map(c=>c[0]),['pull']);assert.deepEqual(modes,['read','read','write']);await x.driver.close();
});
test('closing while remote opens retires late resource without starting replication',async()=>{
 let release,closes=0;const x=fixture({openRemote:()=>new Promise(r=>release=()=>r({database:{},close:async()=>closes++}))});const run=x.driver.synchronize();assert.equal(x.driver.synchronize(),run);while(!release)await new Promise(r=>setImmediate(r));const close=x.driver.close();release();await assert.rejects(run,/closed/);await close;assert.deepEqual(x.calls,[]);assert.equal(closes,1);
});
test('close cancels active replication and waits for settlement before remote close',async()=>{
 const events=[];let release;const operation=new Promise(r=>release=r);operation.cancel=()=>{events.push('cancel');release({status:'cancelled'})};
 const x=fixture({database:{replicate:{from:()=>operation}},openRemote:async()=>({database:{},close:async()=>events.push('close')})});const run=x.driver.synchronize();await new Promise(r=>setImmediate(r));await x.driver.close();await assert.rejects(run,/cancelled/);assert.deepEqual(events,['cancel','close']);await assert.rejects(x.driver.synchronize(),/closed/);
});
test('replication errors are reported instead of claiming complete or starting push',async()=>{
 let pushed=false;const x=fixture({database:{replicate:{from:async()=>({ok:true,errors:[{status:403}]}),to:()=>{pushed=true}}}});await assert.rejects(x.driver.synchronize(),/incomplete/);assert.equal(pushed,false);await x.driver.close();
});
