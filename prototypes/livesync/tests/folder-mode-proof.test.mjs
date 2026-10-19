import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createMessageTranslator} from '../plugin/message-language.mjs';
import catalog from '../plugin/message-catalog.mjs';
const require=createRequire(new URL('../.cache/source/package.json',import.meta.url));
const {getConfiguredFunctionsForEncryption}=await import(new URL('encryption.js',pathToFileURL(require.resolve('@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB'))).href);
const {build}=require('esbuild');
const dir=await mkdtemp(tmpdir()+'/mode-proof-');let verify,messages;
try{
 await build({entryPoints:[fileURLToPath(new URL('../plugin/folder-mode-proof.mjs',import.meta.url))],outfile:dir+'/proof.mjs',bundle:true,platform:'node',format:'esm',nodePaths:[fileURLToPath(new URL('../.cache/source/node_modules',import.meta.url))]});
 ({verifyModeProofPage:verify,modeProofMessages:messages}=await import(pathToFileURL(dir+'/proof.mjs')));
}finally{await rm(dir,{recursive:true,force:true});}
const phrase='test-only metadata proof',salt=new Uint8Array(32).fill(11),parameters={pbkdf2salt:Buffer.from(salt).toString('base64')};
const response=(witnesses,extra={})=>({encrypted:true,witnesses,parameters,cursor:null,proof:'signed-final',...extra});
for(const [algorithm,dynamic] of [['forceV1',false],['forceV1',true],['v2',false]])test('mode proof decrypts real engine '+algorithm+' dynamic='+dynamic+' without exporting plaintext',async()=>{
 const engine=getConfiguredFunctionsForEncryption(phrase,dynamic,false,async()=>salt,algorithm);
 const chunk=await engine.incoming({_id:'h:+chunk',type:'leaf',data:'private chunk bytes'});
 const note=await engine.incoming({_id:'f:note',type:'plain',path:'Личное/Заметка.md',children:[],eden:{'h:embedded':{data:'private embedded bytes',epoch:1}},mtime:1,ctime:1,size:12});
 const witnesses=[{kind:'data',data:chunk.data},{kind:note.path.startsWith('/\\:')?'metadata':'path',data:note.path.startsWith('/\\:')?note.path.slice(3):note.path},...Object.values(note.eden).map(x=>({kind:'eden',data:x.data}))];
 assert.equal(chunk.e_,true);assert.equal(await verify(response(witnesses),{encrypt:true,passphrase:phrase,useDynamicIterationCount:dynamic}),3);
 await assert.rejects(verify(response(witnesses),{encrypt:true,passphrase:'wrong key'}),e=>e.code==='workspace-encryption-key-invalid');
 await assert.rejects(verify(response(witnesses),{encrypt:false}),e=>e.code==='workspace-encryption-mismatch');
 if(algorithm==='v2')await assert.rejects(verify(response(witnesses,{parameters:{pbkdf2salt:Buffer.alloc(32,9).toString('base64')}}),{encrypt:true,passphrase:phrase}),e=>e.code==='workspace-encryption-key-invalid');
});
test('neutral and plain pages do not need keys; malformed or ambiguous results cannot finish recovery',async()=>{
 assert.equal(await verify(response([],{encrypted:false}),{encrypt:false}),0);
 assert.equal(await verify(response([],{encrypted:null,cursor:'next',proof:null}),{encrypt:false}),0);
 for(const page of [response([], {encrypted:'false'}),response([], {cursor:null,proof:null}),response([{kind:'unknown',data:'%'+'a'.repeat(100)}]),response([{kind:'data',data:'plaintext'}]),response(new Array(9).fill({}))])
  await assert.rejects(verify(page,{encrypt:true,passphrase:phrase}),e=>e.code==='workspace-encryption-unreadable');
 await assert.rejects(verify(response([],{encrypted:false}),{encrypt:true}),e=>e.code==='workspace-encryption-mismatch');
});
test('all mode recovery messages translate in both directions without technical error codes',()=>{
 const translate=createMessageTranslator(catalog);
 for(const ru of Object.values(messages)){
  const en=translate(ru,'en');assert.notEqual(en,ru);assert.doesNotMatch(en,/[А-Яа-яЁё]/);assert.equal(translate(en,'ru'),ru);assert.doesNotMatch(en,/workspace-encryption-/);
 }
});
