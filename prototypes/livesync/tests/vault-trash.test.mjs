import test from 'node:test';
import assert from 'node:assert/strict';
import {patchVaultTrash} from '../scripts/patch-peer-file-policy.mjs';
const method='        return await this.app.fileManager.trashFile(file);';
const Adapter=new Function('return '+patchVaultTrash('class Adapter {async trash(file){\n'+method+'\n}async delete(file){\n'+method+'\n}}').replaceAll(' as unknown',''))();
test('system-trash refusal falls back to recoverable local trash',async()=>{
 const adapter=new Adapter(),calls=[];
 let exists=true;
 adapter.app={fileManager:{trashFile:async()=>false},vault:{trash:async(file,system)=>{calls.push(system);exists=false;},adapter:{exists:async()=>exists}}};
 await adapter.trash({path:'note.md'});
 assert.deepEqual(calls,[false]);
});
test('a file remaining after deletion is reported as failure',async()=>{
 const adapter=new Adapter();
 adapter.app={fileManager:{trashFile:async()=>true},vault:{adapter:{exists:async()=>true}}};
 await assert.rejects(adapter.trash({path:'note.md'}),/did not remove/);
});
