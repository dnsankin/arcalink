import {safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
/** A partial, foreign or malformed response must never become an instruction. */
export function checkedShared2Bindings(value,scope){
 if(!scope||!identity(scope.account)||!identity(scope.workspace)||!value||value.protocol!==1||value.account!==scope.account||value.workspace!==scope.workspace||value.complete!==true||!integer(value.revision)||value.legacyUpgradeRequiredOnActivation!==true||!Array.isArray(value.bindings)||value.bindings.length>1000)throw fail('shared2-invalid-bindings-snapshot');
 const seen=new Set();
 for(const row of value.bindings){
  if(!row||row.account!==scope.account||row.workspace!==scope.workspace||typeof row.folder!=='string'||!/^[a-f0-9]{32}$/.test(row.folder)||seen.has(row.folder)||!safeRelative(row.mount)||!['connected','disconnected'].includes(row.state)||![row.revision,row.generation,row.authority_epoch,row.membership_epoch].every(n=>integer(n)&&n>0)||![0,1].includes(row.accessible))throw fail('shared2-invalid-bindings-snapshot');
  seen.add(row.folder);
 }
 return structuredClone(value);
}
/** Check actual storage rather than Obsidian's indexed file view. Repeatedly
 * perform this check immediately before publishing a local attachment. */
export async function assertEmptyShared2Mount(adapter,path,validate){
 if(!safeRelative(path)||typeof validate!=='function'||typeof adapter?.stat!=='function'||typeof adapter?.list!=='function')throw fail('shared2-invalid-mount');
 validate(path);
 let parent='';
 for(const part of path.split('/')){
  const listing=await adapter.list(parent);
  if(!listing||!Array.isArray(listing.files)||!Array.isArray(listing.folders))throw fail('shared2-mount-check-unavailable');
  const next=parent?parent+'/'+part:part;
  const matches=[...listing.files,...listing.folders].filter(item=>typeof item==='string').map(item=>item.replace(/^\/+/,'' )).filter(item=>item.toLowerCase()===next.toLowerCase());
  if(matches.length>1||matches.some(item=>item!==next))throw fail('shared2-mount-case-conflict');
  const stat=await adapter.stat(next);
  if(stat&&stat.type!=='folder')throw fail('shared2-mount-occupied');
  if(!stat){if(matches.length)throw fail('shared2-mount-check-unavailable');validate(path);return;}
  if(matches.length!==1)throw fail('shared2-mount-check-unavailable');
  parent=next;
 }
 const contents=await adapter.list(path);
 if(!contents||!Array.isArray(contents.files)||!Array.isArray(contents.folders))throw fail('shared2-mount-check-unavailable');
 if(contents.files.length||contents.folders.length)throw fail('shared2-mount-occupied');
 validate(path);
}
/** Inventory a mounted tree from the adapter, including files absent from the
 * vault index. Never follow malformed paths or ambiguous case collisions. */
export async function listPhysicalShared2Files(adapter,root){
 if(!safeRelative(root)||typeof adapter?.list!=='function'||typeof adapter?.stat!=='function')throw fail('shared2-mount-check-unavailable');
 const todo=[root],files=[],seen=new Set();
 while(todo.length){
  const parent=todo.pop(),listing=await adapter.list(parent);
  if(!listing||!Array.isArray(listing.files)||!Array.isArray(listing.folders))throw fail('shared2-mount-check-unavailable');
  for(const [type,items] of [['file',listing.files],['folder',listing.folders]])for(const path of items){
   if(typeof path!=='string'||!safeRelative(path)||!path.startsWith(parent+'/')||path.slice(parent.length+1).includes('/'))throw fail('shared2-mount-check-unavailable');
   const folded=path.toLowerCase();if(seen.has(folded))throw fail('shared2-mount-case-conflict');seen.add(folded);
   const stat=await adapter.stat(path);if(!stat||stat.type!==type)throw fail('shared2-mount-check-unavailable');
   if(type==='folder')todo.push(path);else files.push(path);
  }
 }
 return files.sort();
}
