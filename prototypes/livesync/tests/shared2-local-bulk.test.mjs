import test from 'node:test';import assert from 'node:assert/strict';import {wrapShared2LocalBulk} from '../plugin/shared2-local-bulk.mjs';
test('deduplicated chunk writes preserve one result per input in callback and promise forms',async()=>{
 const calls=[],db=wrapShared2LocalBulk({bulkDocs:async docs=>{calls.push(docs);return docs.map(doc=>({ok:true,id:doc._id,rev:'1-x'}))}}),leaf={_id:'h:one',type:'leaf',data:'same'};
 let callback;const result=await db.bulkDocs([leaf,{...leaf}],(error,rows)=>{assert.equal(error,null);callback=rows;});assert.equal(calls[0].length,1);assert.equal(result.length,2);assert.equal(callback.length,2);assert.notEqual(result[0],result[1]);
});
test('revision imports and mixed chunk bytes retain exact original arguments and branches',async()=>{
 const calls=[],db=wrapShared2LocalBulk({bulkDocs:function(...args){calls.push(args);return Promise.resolve([])}}),leaf={_id:'h:one',type:'leaf',data:'same'};
 const request={docs:[leaf,{...leaf}],new_edits:false};await db.bulkDocs(request);assert.equal(calls[0].length,1);assert.equal(calls[0][0],request);
 const docs=[leaf,{...leaf,data:'different'}];await db.bulkDocs(docs);assert.equal(calls[1][0],docs);
});
