import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceFileHandlerBase} from '../.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/serviceModules/ServiceFileHandlerBase.js';

async function check({data='same',conflicts,stable=true}={}){
 const handler=Object.create(ServiceFileHandlerBase.prototype);
 const file={path:'note.md',body:new Blob(['same']),stat:{mtime:1}};
 handler.readProvenanceSnapshot=async()=>undefined;
 handler.readFileFromStub=async()=>file;
 handler.currentStorageSnapshotMatches=async()=>stable;
 handler.databaseFileAccess={fetchEntryFromMeta:async()=>({datatype:'plain',data:[data]})};
 handler.classifyStorageContent=async()=>{throw Error('preservation required');};
 return handler.preserveUnsyncedStorageAsConflict('note.md',file,{_rev:'2-delete',deleted:true,_conflicts:conflicts});
}
test('a matching deletion snapshot can be applied without legacy provenance',async()=>{
 const result=await check();
 assert.equal(result.preserved,false);
 assert.ok(result.snapshot);
});
test('changed bytes and competing branches still require preservation',async()=>{
 await assert.rejects(check({data:'different'}),/preservation required/);
 await assert.rejects(check({conflicts:['1-other']}),/preservation required/);
});
test('a concurrent filesystem change prevents accepting the snapshot',async()=>{
 assert.deepEqual(await check({stable:false}),{preserved:false});
});
