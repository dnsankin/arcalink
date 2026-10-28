import test from 'node:test';import assert from 'node:assert/strict';import {readLargeContent} from '../plugin/large-content-gate.mjs';
const meta={_id:'video',_rev:'1-a',size:64*1024*1024};
test('large Android reads share an in-flight revision and serialize different revisions',async()=>{
 const db={},events=[];let release;const a=readLargeContent(db,meta,[],true,()=>{events.push('a');return new Promise(r=>release=r);});
 const same=readLargeContent(db,meta,[],true,()=>assert.fail('duplicate'));
 const b=readLargeContent(db,{...meta,_rev:'2-b'},[],true,async()=>{events.push('b');return 'new';});
 assert.equal(a,same);await new Promise(r=>setImmediate(r));assert.deepEqual(events,['a']);release('old');assert.equal(await a,'old');assert.equal(await b,'new');assert.deepEqual(events,['a','b']);
});
test('failed read does not block next file; DB identity and options isolate results',async()=>{
 const db={};const a=readLargeContent(db,meta,[],true,async()=>{throw Error('offline');});const b=readLargeContent(db,meta,[true],true,async()=>42);await assert.rejects(a,/offline/);assert.equal(await b,42);
 assert.equal(await readLargeContent({},meta,[],true,async()=>7),7);
});
test('desktop and small file reads keep independent immediate execution',async()=>{let count=0;const db={};for(const [m,mobile] of [[meta,false],[{...meta,size:5},true]]){const a=readLargeContent(db,m,[],mobile,async()=>++count);const b=readLargeContent(db,m,[],mobile,async()=>++count);assert.notEqual(a,b);await Promise.all([a,b]);}assert.equal(count,4);});
import {assembleBinaryChunks} from '../plugin/large-content-gate.mjs';
test('chunkwise binary assembly preserves exact bytes and reads one block per call',async()=>{
 const chunks=[Buffer.from([0,255,17]),Buffer.from('video bytes'),Buffer.from([128,1])],ids=['a','b','c'],calls=[];
 const result=await assembleBinaryChunks({size:chunks.reduce((n,b)=>n+b.length,0),children:ids},async keys=>{calls.push(keys);return[{data:chunks[ids.indexOf(keys[0])].toString('base64')}];},s=>Uint8Array.from(Buffer.from(s,'base64')).buffer);
 assert.deepEqual(Buffer.from(result),Buffer.concat(chunks));assert.deepEqual(calls,[['a'],['b'],['c']]);
});
test('chunkwise assembly refuses missing, truncated and overflowing content',async()=>{
 const decode=s=>Uint8Array.from(Buffer.from(s,'base64')).buffer;
 await assert.rejects(assembleBinaryChunks({size:1,children:['a']},async()=>[false],decode),/Missing/);
 for(const size of [1,3])await assert.rejects(assembleBinaryChunks({size,children:['a']},async()=>[{data:'AQI='}],decode),/size/);
});
import {patchLargeContent,patchDecodedBinary} from '../scripts/patch-large-content.mjs';
test('guarded build patches refuse upstream drift',()=>{assert.throws(()=>patchLargeContent('changed'),/Unexpected upstream/);assert.throws(()=>patchDecodedBinary('changed'),/Unexpected upstream/);});
test('legacy encoded chunks retain their first-chunk format across subsequent chunks',async()=>{
 const seen=[];const result=await assembleBinaryChunks({size:4,children:['a','b']},async ids=>[{data:ids[0]==='a'?'%ab':'cd'}],s=>{seen.push(s);return new Uint8Array([...s.slice(1)].map(x=>x.charCodeAt(0))).buffer;});
 assert.deepEqual(seen,['%ab','%cd']);assert.deepEqual([...new Uint8Array(result)],[97,98,99,100]);
});
test('decoded buffers are reused by the generated binary decoder and Blob adapter',async()=>{
 const {readContent,readAsBlob}=await import('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/common/utils.js');
 const data=new Uint8Array([0,128,255,11]).buffer,doc={type:'newnote',datatype:'newnote',path:'clip.mp4',data};
 assert.equal(readContent(doc),data);assert.equal(readAsBlob(doc).size,4);assert.deepEqual([...new Uint8Array(await readAsBlob(doc).arrayBuffer())],[0,128,255,11]);
});
test('generated reader bounds large files on desktop as well as Android',async()=>{
 const {readFile}=await import('node:fs/promises');
 const reader=await readFile(new URL('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/managers/EntryManager/EntryManagerImpls.js',import.meta.url),'utf8');
 assert.ok(reader.includes('meta, [dump, waitForReady, localOnly], true,'));
 assert.ok(reader.includes('if (meta.type === "newnote"'));
 assert.ok(!reader.includes('arcaPlatform'));
});
