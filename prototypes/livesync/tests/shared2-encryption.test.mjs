import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {shared2PouchProgressPlugin} from '../scripts/shared2-pouch-progress.mjs';
const source=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(source+'esbuild.config.mjs');const {build}=require('esbuild');
const output=(await build({stdin:{contents:`export {configureShared2Encryption,resolveShared2Key} from '../../plugin/shared2-encryption.mjs';export {createShared2LocalEngineFactory} from '../../plugin/shared2-local-engine.mjs';import PouchDB from 'pouchdb-core';import Memory from 'pouchdb-adapter-memory';import Replication from 'pouchdb-replication';import Transform from 'transform-pouch';PouchDB.plugin(Memory).plugin(Replication).plugin(Transform);export const createDB=(name)=>new PouchDB(name,{adapter:'memory'});`,resolveDir:source},bundle:true,plugins:[shared2PouchProgressPlugin()],platform:'node',format:'cjs',write:false,nodePaths:[source+'node_modules']})).outputFiles[0].text;const Module=require('node:module'),mod=new Module('shared2-encryption-test');mod.filename=source+'shared2-encryption-test.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output,mod.filename);const {configureShared2Encryption,resolveShared2Key,createShared2LocalEngineFactory,createDB}=mod.exports;
const profile={kind:'shared',account:'alice',workspace:'work',folder:'a'.repeat(32),database:'arcalink_s_'+'b'.repeat(32),generation:1,keyEpoch:1,encrypted:true,role:'editor',revision:1,catalogRevision:1};
const key=(p=profile,passphrase='c'.repeat(64))=>({...p,passphrase,salt:new Uint8Array(32).fill(17)});
const makeEngine=(p,remote,provider)=>createShared2LocalEngineFactory({namespace:'shared2-crypto-'+crypto.randomUUID(),createPouchDB:name=>createDB(name),settingsFor:async p=>({database:p.database,generation:p.generation,settings:{hashAlg:'sha1',chunkSplitterVersion:'v1',disableWorkerForGeneratingChunks:true,disableWorkerForDecrypting:true,useEden:false}}),keyProvider:provider,openRemote:async()=>({database:remote,close:async()=>{}}),accessCheck:async()=>true})(p);
test('scope/key-epoch mismatch fails before exposing material to an engine',async()=>{await assert.rejects(resolveShared2Key(profile,async()=>key({...profile,folder:'e'.repeat(32)})),/scope-mismatch/);await assert.rejects(resolveShared2Key(profile,async()=>key({...profile,keyEpoch:2})),/scope-mismatch/);});
test('pinned V2 transform stores encrypted chunks and metadata and two engines restore exact text',{timeout:10000},async t=>{
 const timer=setInterval(()=>{},1000);t.after(()=>clearInterval(timer));
 const name='shared2-cipher-'+crypto.randomUUID(),raw=createDB(name),writer=createDB(name),reader=createDB(name);let a,b;
 try{
  await raw.put({_id:'_design/arcalink_shared2_access',filters:{files:"function(doc,req){return doc._id.charAt(0)!=='_';}"}});
  await configureShared2Encryption(writer,profile,async()=>key());await configureShared2Encryption(reader,profile,async()=>key());
  a=await makeEngine(profile,writer,async()=>key());b=await makeEngine(profile,reader,async()=>key());
  const text='Секретная заметка shared2 '+crypto.randomUUID();await a.write('Team/secret.md',{bytes:new TextEncoder().encode(text)});await a.synchronize();
  const docs=(await raw.allDocs({include_docs:true})).rows.map(row=>row.doc);assert.ok(docs.some(doc=>doc.type==='leaf'&&doc.e_===true));assert.equal(JSON.stringify(docs).includes(text),false);assert.equal(JSON.stringify(docs).includes('Team/secret.md'),false);
  const meta=await reader.get(docs.find(doc=>doc.type==='plain')._id);let restored='';for(const id of meta.children)restored+=(await reader.get(id)).data;assert.equal(restored,text);await b.synchronize();assert.equal(new TextDecoder().decode((await b.read('Team/secret.md')).bytes),text);
 }finally{if(a)await a.close();if(b)await b.close();await raw.destroy();}
});

test('wrong key and plaintext network documents fail closed; other folder key is not reused',async()=>{
 const name='shared2-wrong-key-'+crypto.randomUUID(),raw=createDB(name),writer=createDB(name),wrong=createDB(name),correct=createDB(name);
 try{
  await configureShared2Encryption(writer,profile,async()=>key());await configureShared2Encryption(correct,profile,async()=>key());await configureShared2Encryption(wrong,profile,async()=>key(profile,'d'.repeat(64)));
  await writer.put({_id:'h:+test',type:'leaf',data:'private bytes'});
  await assert.rejects(wrong.get('h:+test'),/decryption-rejected/);assert.equal((await correct.get('h:+test')).data,'private bytes');
  await raw.put({_id:'h:plaintext',type:'leaf',data:'unprotected'});await assert.rejects(correct.get('h:plaintext'),/plaintext-chunk-rejected/);
  await raw.put({_id:'f:plaintext',type:'plain',path:'private.md',children:[],size:0});await assert.rejects(correct.get('f:plaintext'),/plaintext-metadata-rejected/);
  await assert.rejects(configureShared2Encryption(createDB('shared2-other-'+crypto.randomUUID()),{...profile,folder:'e'.repeat(32)},async()=>key()),/scope-mismatch/);
 }finally{await raw.destroy();}
});
