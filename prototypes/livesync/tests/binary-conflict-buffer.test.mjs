import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {patchBinaryConflictReader} from '../scripts/patch-large-content.mjs';
import {assembleBinaryChunks} from '../plugin/large-content-gate.mjs';

const managerURL=new URL('../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/managers/ConflictManager.js',import.meta.url);
const source=await readFile(managerURL,'utf8');
const patched=source.includes('      const data = doc.datatype == "newnote"')?source:patchBinaryConflictReader(source);
const fixtureURL=new URL(`.binary-conflict-buffer-test-${process.pid}.mjs`,managerURL);
let ConflictManager;
try {
 await writeFile(fixtureURL,patched);
 ({ConflictManager}=await import(fixtureURL.href));
}finally{await unlink(fixtureURL);}

function manager(documents) {
 const calls=[];
 const entryManager={getDBEntry:async(path,options)=>{
  calls.push({path,options});
  const doc=documents[options.rev||'current'];
  if(doc instanceof Error)throw doc;
  return doc??false;
 }};
 return {engine:new ConflictManager({entryManager}),calls};
}
function binary(data,rev='1-a',extra={}) {
 return {path:'fixture.mp4',_rev:rev,datatype:'newnote',data,mtime:1,ctime:1,...extra};
}
const buffer=bytes=>Uint8Array.from(bytes).buffer;

test('guarded patch refuses upstream drift and double application',()=>{
 assert.throws(()=>patchBinaryConflictReader('changed'),/Unexpected upstream/);
 assert.throws(()=>patchBinaryConflictReader(patched),/Unexpected upstream/);
});
test('decoded buffers are readable, including zero length and binary bytes',async()=>{
 for(const bytes of [[],[0,1,2,127],[128,255,0,10]]){
  const a=await manager({current:binary(buffer(bytes))}).engine.getConflictedDoc('fixture.mp4',undefined);
  const b=await manager({current:binary([Buffer.from(bytes).toString('base64')])}).engine.getConflictedDoc('fixture.mp4',undefined);
  assert.notEqual(a,false);assert.notEqual(b,false);assert.equal(a.data,b.data);
 }
});
test('old base64 chunks and plain text retain their previous decoded content',async()=>{
 const docs={base64:binary(['aGVsbG8=']),text:{datatype:'plain',data:['hello','\nworld'],ctime:1,mtime:2}};
 const {engine}=manager(docs);
 assert.equal((await engine.getConflictedDoc('fixture.mp4','base64')).data,'hello');
 assert.equal((await engine.getConflictedDoc('fixture.md','text')).data,'hello\nworld');
});
test('same binary bytes across stored formats remain equal despite different timestamps',async()=>{
 const current=binary(buffer([1,2,3]),'1-left',{_conflicts:['1-right'],mtime:1});
 const right=binary(['AQID'],'1-right',{mtime:2});
 const {engine}=manager({current,'1-left':current,'1-right':right});
 const result=await engine.tryAutoMerge('fixture.mp4',true);
 assert.notEqual(result.leftLeaf,false);assert.notEqual(result.rightLeaf,false);
 assert.equal(result.leftLeaf.data,result.rightLeaf.data);
 assert.equal(result.leftRev,'1-left');assert.equal(result.rightRev,'1-right');
 assert.equal(result.leftLeaf.mtime,1);assert.equal(result.rightLeaf.mtime,2);
});
test('different bytes are not converted to an equal placeholder or merged by the reader',async()=>{
 const current=binary(buffer([1,2,3]),'1-left',{_conflicts:['1-right']});
 const right=binary(buffer([1,2,4]),'1-right');
 const result=await manager({current,'1-left':current,'1-right':right}).engine.tryAutoMerge('fixture.mp4',true);
 assert.notEqual(result.leftLeaf.data,result.rightLeaf.data);
 assert.equal('result' in result,false);
});
test('missing, unreadable and malformed branches stay unreadable rather than disposable',async()=>{
 for(const bad of [false,new Error('missing chunk'),binary({not:'supported'})]){
  const current=binary(buffer([1]),'1-left',{_conflicts:['1-right']});
  const result=await manager({current,'1-left':current,'1-right':bad}).engine.tryAutoMerge('fixture.mp4',true);
  assert.notEqual(result.leftLeaf,false);assert.equal(result.rightLeaf,false);
 }
});
test('deletion flags and three independent revisions are preserved for existing selection',async()=>{
 const current=binary(buffer([1]),'2-left',{_conflicts:['1-newer','1-older']});
 const docs={current,'2-left':current,'1-newer':binary(buffer([1]),'1-newer',{mtime:3,deleted:true}),'1-older':binary(buffer([2]),'1-older',{mtime:2})};
 const result=await manager(docs).engine.tryAutoMerge('fixture.mp4',true);
 assert.equal(result.rightRev,'1-older');assert.notEqual(result.leftLeaf.data,result.rightLeaf.data);
 assert.equal((await manager(docs).engine.getConflictedDoc('fixture.mp4','1-newer')).deleted,true);
});
test('actual 32 MiB chunk assembly can be compared without the string-array join failure',async()=>{
 const size=32*1024*1024,piece=Buffer.alloc(1024*1024,65).toString('base64');
 const assembled=await assembleBinaryChunks({size,children:Array.from({length:32},(_,i)=>`h:${i}`)},async()=>[{data:piece}],s=>Uint8Array.from(Buffer.from(s,'base64')).buffer);
 const current=binary(assembled,'1-left',{size,_conflicts:['1-right']});
 const right=binary(assembled.slice(0),'1-right',{size,mtime:2});
 const result=await manager({current,'1-left':current,'1-right':right}).engine.tryAutoMerge('fixture.mp4',true);
 assert.notEqual(result.leftLeaf,false);assert.notEqual(result.rightLeaf,false);
 assert.equal(result.leftLeaf.data.length,size);assert.equal(result.leftLeaf.data,result.rightLeaf.data);
});
test('removing only an identical losing root preserves winner and chunks on both replicas',async()=>{
 const require=createRequire(new URL('../.cache/source/esbuild.config.mjs',import.meta.url));
 const PouchDB=require('pouchdb-core');PouchDB.plugin(require('pouchdb-adapter-memory')).plugin(require('pouchdb-replication'));
 const a=new PouchDB('binary-conflict-'+crypto.randomUUID(),{adapter:'memory'});
 const b=new PouchDB('binary-mirror-'+crypto.randomUUID(),{adapter:'memory'});
 try{
  await a.put({_id:'h:chunk',type:'leaf',data:'AQID'});
  const doc={_id:'clip',type:'newnote',path:'clip.mp4',size:3,children:['h:chunk']};
  await a.bulkDocs([{...doc,_rev:'1-a',mtime:1},{...doc,_rev:'1-b',mtime:2}],{new_edits:false});
  await PouchDB.replicate(a,b);
  const before=await a.get('clip',{conflicts:true});assert.equal(before._conflicts.length,1);
  await a.remove('clip',before._conflicts[0]);await PouchDB.replicate(a,b);
  for(const db of [a,b]){
   const after=await db.get('clip',{conflicts:true});
   assert.equal(after._rev,before._rev);assert.equal(after._conflicts,undefined);
   assert.deepEqual(after.children,before.children);assert.equal((await db.get('h:chunk')).data,'AQID');
  }
 }finally{await a.destroy();await b.destroy();}
});
