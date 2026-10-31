import test from 'node:test';
import assert from 'node:assert/strict';
import {folderTree,folderTreeMatches,folderRuleState,setFolderIncluded} from '../plugin/folder-rules-tree.mjs';
import {folderContains,withExcludedFolders,excludedFolders} from '../plugin/folder-exclusions.mjs';
import {createMessageTranslator} from '../plugin/message-language.mjs';
import catalog from '../plugin/message-catalog.mjs';
const state=(path,local=new Set(),common=new Set(),localCase=false,commonCase=false)=>folderRuleState(path,local,common,folderContains,localCase,commonCase);
test('tree restores missing ancestors of remote exclusions and preserves distinct folder boundaries',()=>{
 const {roots,nodes}=folderTree(['Фото/2026/Турция','Фото/2026','Фотоархив','Офлайн/Сохранить','Фото/2026/Турция']);
 assert.equal(roots.length,3);assert.equal(nodes.size,6);assert.deepEqual(nodes.get('Фото').children.map(n=>n.path),['Фото/2026']);
 assert.equal(nodes.get('Офлайн/Сохранить').parent,'Офлайн');assert.equal(nodes.get('Фото/2026/Турция').name,'Турция');
});
test('search keeps ancestors visible and opens every branch to Unicode matches without altering saved expansion',()=>{
 const {nodes}=folderTree(['Фото/2026/Турция','Фото/2025','Работа']);
 const result=folderTreeMatches(nodes,'  ТУРЦИЯ ');
 assert.deepEqual([...result.visible].sort(),['Фото','Фото/2026','Фото/2026/Турция']);assert.deepEqual([...result.opened].sort(),['Фото','Фото/2026']);
 assert.equal(folderTreeMatches(nodes,'   ').visible.size,nodes.size);assert.equal(folderTreeMatches(nodes,'unknown').visible.size,0);
});
test('both checkboxes default to on and changing local preference cannot remove a cloud rule',()=>{
 const local=new Set(),common=new Set();assert.equal(state('Фото',local,common).local,true);assert.equal(state('Фото',local,common).cloud,true);
 setFolderIncluded(local,'Фото',false,folderContains,false);assert.equal(state('Фото',local,common).local,false);assert.equal(state('Фото',local,common).cloud,true);
 common.add('Фото');setFolderIncluded(local,'Фото',true,folderContains,false);assert.equal(common.has('Фото'),true);assert.equal(state('Фото',local,common).local,false);
});
test('cloud exclusion disables effective local sync without discarding an independent local preference',()=>{
 for(const localExcluded of [false,true]){
  const local=new Set(localExcluded?['Фото']:[]),common=new Set();
  setFolderIncluded(common,'Фото',false,folderContains,false);assert.equal(state('Фото',local,common).cloud,false);assert.equal(state('Фото',local,common).local,false);
  assert.equal(local.has('Фото'),localExcluded);setFolderIncluded(common,'Фото',true,folderContains,false);
  assert.equal(state('Фото',local,common).local,!localExcluded);assert.equal(state('Фото',local,common).cloud,true);
 }
});
test('ancestor exclusions take priority even if inserted after a direct child preference',()=>{
 const local=new Set(['Фото/2026','Фото']),common=new Set(['Работа']);
 assert.equal(state('Фото/2026',local,common).localParent,'Фото');assert.equal(state('Работа/Задачи',local,common).commonParent,'Работа');
 assert.equal(state('Фотоархив',local,common).local,true);assert.equal(state('Работа_архив',local,common).cloud,true);
 assert.equal(state('ФОТО/2026',local,common).local,false);assert.equal(state('ФОТО/2026',local,common,true).local,true);
});
test('case-insensitive matching toggles the existing rule and custom regex survives unchanged',()=>{
 const local=new Set(['ФОТО']);setFolderIncluded(local,'Фото',true,folderContains,false);assert.equal(local.size,0);
 const original='^Custom/secret$|[]|'+withExcludedFolders('', ['Фото']);
 const next=withExcludedFolders(original,[...local]);assert.equal(next,'^Custom/secret$');assert.deepEqual(excludedFolders(original),['Фото']);
});
test('new tree guidance and accessible checkbox labels translate both ways',()=>{
 const translate=createMessageTranslator(catalog);
 for(const key of ['Folder','Folders','On this device','Cloud','No folders found.','Collapse folder','Expand folder','Sync on this device','Keep in the cloud','Inherited from a parent folder. Change the parent rule.','This folder is excluded on all devices. The local preference is kept.']){
  const ru=translate(key,'ru');assert.notEqual(ru,key);assert.equal(translate(ru,'en'),key);
 }
});
import {foldersContainingFiles} from '../plugin/folder-rules-tree.mjs';
test('picker indexes populated ancestors in one pass and preserves sibling boundaries',()=>{
 let reads=0;const files=Array.from({length:50000},(_,i)=>({get path(){reads++;return 'Root/Child/'+i+'.md'}}));
 const populated=foldersContainingFiles(files);assert.equal(reads,50000);assert.deepEqual([...populated],['Root/Child','Root']);
 assert.equal(populated.has('Root/Child-other'),false);assert.equal(populated.has('Root/Empty'),false);
 assert.deepEqual([...foldersContainingFiles([{path:'root-note.md'}])],[]);
});
