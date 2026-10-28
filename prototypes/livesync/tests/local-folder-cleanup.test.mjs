import test from 'node:test';import assert from 'node:assert/strict';import {withExcludedFolders,excludedLocalFolderRoots,localFolderCleanupBlock,trashExcludedLocalFolder} from '../plugin/folder-exclusions.mjs';
test('lists existing excluded roots once, including inherited common paths, not arbitrary regexes',()=>{
 const state={rules:withExcludedFolders('^custom',['Archive','Missing']),common:['SharedOld'],paths:['Archive','Archive/Sub','SharedOld/Sub','custom','Normal']};
 assert.deepEqual(excludedLocalFolderRoots(state),['Archive','SharedOld/Sub']);
 assert.deepEqual(excludedLocalFolderRoots({...state,rules:withExcludedFolders('',['archive']),common:[],caseSensitive:true}),[]);
});
test('protects parents and descendants of shared and configuration folders',()=>{
 for(const path of ['Team','Team/Sub','Root'])assert.ok(localFolderCleanupBlock(path,{shared:['Team'],protectedPaths:['Root/.obsidian']}));
 assert.equal(localFolderCleanupBlock('Other',{shared:['Team']}),'');
 assert.ok(localFolderCleanupBlock('../escape'));
});
test('deletes through injected recoverable operation only while current exclusion remains',async()=>{
 let state={rules:withExcludedFolders('',['Archive']),paths:['Archive'],shared:[]};const folder={path:'Archive'},calls=[];const original=state.rules;
 const options={snapshot:()=>state,getFolder:()=>folder,trash:async f=>calls.push(f)};
 await trashExcludedLocalFolder('Archive',options);assert.deepEqual(calls,[folder]);assert.equal(state.rules,original);
 state={...state,rules:''};await assert.rejects(trashExcludedLocalFolder('Archive',options),/больше не исключена/);assert.equal(calls.length,1);
 state={...state,rules:original,shared:['Archive/Sub']};await assert.rejects(trashExcludedLocalFolder('Archive',options),/совместные/);assert.equal(calls.length,1);
 state={...state,shared:[]};await assert.rejects(trashExcludedLocalFolder('Archive',{...options,trash:async()=>{throw Error('disk error');}}),/disk error/);assert.equal(state.rules,original);
});
