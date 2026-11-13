import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {proveOwnershipPage,assertOwnershipManifest,ownershipDigest,canonicalOwnership} from '../plugin/companion-ownership-model.mjs';
import {localSnapshotKey,sealLocalPage,openLocalPage,localDocumentPages} from '../plugin/companion-local-snapshot.mjs';
const require=createRequire(new URL('../.cache/source/package.json',import.meta.url));
const Pouch=require('pouchdb-core').plugin(require('pouchdb-adapter-memory'));
const identity=()=>({schema:1,nonce:randomUUID(),generation:randomUUID(),accountId:randomUUID(),companionDeviceId:randomUUID(),workspaceId:'a'.repeat(32)});

test('local snapshot retains unsent branches, tombstones, available chunks and explicit missing chunks without any remote call',async t=>{
 const source=new Pouch(randomUUID(),{adapter:'memory'}),target=new Pouch(randomUUID(),{adapter:'memory'});
 t.after(async()=>{await source.destroy();await target.destroy();});
 await source.bulkDocs([
  {_id:'note.md',_rev:'2-local',_revisions:{start:2,ids:['local','root']},path:'note.md',type:'plain',children:['h:one','h:missing'],size:12},
  {_id:'note.md',_rev:'2-conflict',_revisions:{start:2,ids:['conflict','root']},path:'note.md',type:'plain',children:[],deleted:true},
  {_id:'gone.md',_rev:'3-deleted',_revisions:{start:3,ids:['deleted','parent','root']},_deleted:true},
  {_id:'h:one',_rev:'1-leaf',_revisions:{start:1,ids:['leaf']},type:'leaf',data:'local unsent bytes'},
 ],{new_edits:false});
 const sequence=(await source.info()).update_seq;
 const result=await proveOwnershipPage({source,remote:new Proxy({},{get(){throw Error('network forbidden');}}),sequence,localOnly:true});
 const manifest={...identity(),phase:'held',mode:'cloud',source:{sequence},scope:{ordinary:true,excludedPrefixes:[]},bases:[],records:result.records,createdAt:Date.now(),localSnapshot:{version:1,pages:[]}};
 const key=await localSnapshotKey('synthetic-session-key-not-a-real-token',manifest),envelopes=[];
 for(const docs of localDocumentPages(result.documents)){
  const index=envelopes.length,envelope=await sealLocalPage(manifest,sequence,index,docs,key);envelopes.push(envelope);
  manifest.localSnapshot.pages.push({index,sha256:await ownershipDigest(envelope),size:Buffer.byteLength(canonicalOwnership(envelope))});
 }
 assertOwnershipManifest(manifest);
 assert.equal(JSON.stringify(envelopes).includes('local unsent bytes'),false);
 assert.deepEqual(manifest.records.find(x=>x.id==='note.md').leaves.find(x=>x.rev==='2-local').missingChunks,['h:missing']);
 // Retry the same import after a simulated lost acknowledgement.
 for(let attempt=0;attempt<2;attempt++)for(let i=0;i<envelopes.length;i++)assert.deepEqual(await target.bulkDocs(await openLocalPage(manifest,i,envelopes[i],key),{new_edits:false}),[]);
 for(const id of ['note.md','gone.md','h:one'])assert.deepEqual(await target.get(id,{open_revs:'all',revs:true}),await source.get(id,{open_revs:'all',revs:true}));
 await assert.rejects(target.get('h:missing'),{status:404});
 const altered=structuredClone(manifest);delete altered.localSnapshot;assert.throws(()=>assertOwnershipManifest(altered),{code:'invalid-local-snapshot'});
 for(const mutation of [x=>x.generation=randomUUID(),x=>x.source.sequence++,x=>x.localSnapshot.pages[0].sha256='0'.repeat(64)]){
  const changed=structuredClone(manifest);mutation(changed);await assert.rejects(openLocalPage(changed,0,envelopes[0],key),{code:'ownership-local-snapshot-invalid'});
 }
 const corrupted=structuredClone(envelopes[0]);corrupted.ciphertext='AAAA'+corrupted.ciphertext.slice(4);
 // Even if an attacker recomputes the public checksum, GCM authentication fails.
 const alteredHash=structuredClone(manifest);alteredHash.localSnapshot.pages[0].sha256=await ownershipDigest(corrupted);
 await assert.rejects(openLocalPage(alteredHash,0,corrupted,key),{code:'ownership-local-snapshot-invalid'});
 await assert.rejects(openLocalPage(manifest,0,envelopes[0],'f'.repeat(64)),{code:'ownership-local-snapshot-invalid'});
});

test('large many-chunk note is transported in bounded pages; missing bodies are not confused with database read failures',async t=>{
 const docs=Array.from({length:307},(_,i)=>({_id:'h:'+i,_rev:'1-root',type:'leaf',data:'x'.repeat(4096)}));
 const pages=localDocumentPages(docs);assert.ok(pages.length>1);assert.equal(pages.flat().length,307);
 assert.ok(pages.every(page=>Buffer.byteLength(canonicalOwnership({documents:page}))<270000));
 const source=new Pouch(randomUUID(),{adapter:'memory'});t.after(()=>source.destroy());
 await source.put({_id:'note.md',path:'note.md',type:'plain',children:['h:broken']});
 const get=source.get.bind(source);source.get=async(id,options)=>{if(id==='h:broken')throw Object.assign(Error('storage failed'),{status:500});return get(id,options);};
 await assert.rejects(proveOwnershipPage({source,remote:null,sequence:(await source.info()).update_seq,localOnly:true}),{code:'ownership-local-read-failed'});source.get=get;
});
