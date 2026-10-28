import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {patchIdbMemory} from '../scripts/patch-idb-memory.mjs';
const raw=await readFile(new URL('../.cache/source/node_modules/pouchdb-adapter-idb/lib/index.es.js',import.meta.url),'utf8');
const source=raw.includes("batchSize = Math.min(batchSize, 8)")?raw:patchIdbMemory(raw);
const code=source.slice(source.indexOf('function runBatchedCursor('),source.indexOf('// simple shim for objectStore.getAll()'));
const run=vm.runInNewContext('('+code+')',{IDBKeyRange:{lowerBound:(lower,lowerOpen)=>({lower,lowerOpen}),bound:(lower,upper,lowerOpen,upperOpen)=>({lower,upper,lowerOpen,upperOpen})}});
for(const batch of [-1,2,8,100,1000])test(`change-feed batch ${batch} preserves every record once`,async()=>{
 const data=Array.from({length:37},(_,i)=>i+1),calls=[],seen=[];
 const request=(range,size,keys)=>{calls.push(size);const req={};queueMicrotask(()=>{const values=data.filter(k=>(!range||k>range.lower||(!range.lowerOpen&&k===range.lower))&&(!range?.upper||k<range.upper||(!range.upperOpen&&k===range.upper))).slice(0,size);req.onsuccess({target:{result:keys?values:values.map(k=>({k}))}})});return req};
 await new Promise(resolve=>run({name:'by-sequence',getAll:(r,n)=>request(r,n,false),getAllKeys:(r,n)=>request(r,n,true)},null,false,batch,(keys,values,cursor)=>{if(!keys)return resolve();assert.deepEqual(Array.from(keys),Array.from(values,v=>v.k));seen.push(...keys);cursor.continue()}));
 assert.deepEqual(seen,data);assert.ok(calls.every(n=>n<=8));
});
test('single record and descending still use native cursor',()=>{for(const descending of [false,true]){let direction;run({name:'by-sequence',getAll(){assert.fail()},getAllKeys(){assert.fail()},openCursor:(r,d)=>{direction=d;return {}}},null,descending,1,()=>{});assert.equal(direction,descending?'prev':undefined)}});
test('metadata store retains upstream batch size',()=>{let size;run({name:'document-store',getAll:(r,n)=>{size=n;return{}},getAllKeys:()=>({})},null,false,-1,()=>{});assert.equal(size,1000)});
test('patch rejects upstream drift',()=>assert.throws(()=>patchIdbMemory('changed'),/Unexpected/));
