import test from 'node:test';
import assert from 'node:assert/strict';
import {createDisplayLogQueue} from '../plugin/display-log-queue.mjs';

test('startup messages drain in order and a message added by the consumer follows the batch',async()=>{
 const queue=createDisplayLogQueue(),seen=[];
 for(let n=0;n<10000;n++)queue.append(n);
 queue.listen(entry=>{seen.push(entry);if(!entry)queue.append(10000);});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(seen,Array.from({length:10001},(_,n)=>n));
 queue.append('discard on unload');queue.close();
 await Promise.resolve();
 assert.equal(seen.length,10001);
});
