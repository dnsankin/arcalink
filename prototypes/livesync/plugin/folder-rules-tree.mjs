/** Presentation only. Stored exclusions and the engine filter remain unchanged. */
export function folderTree(paths){
 const nodes=new Map();
 for(const path of paths){
  const parts=path.split('/');
  for(let index=0;index<parts.length;index++){
   const full=parts.slice(0,index+1).join('/');
   if(!nodes.has(full))nodes.set(full,{path:full,name:parts[index],parent:parts.slice(0,index).join('/'),children:[]});
  }
 }
 const roots=[];
 for(const node of nodes.values())(node.parent?nodes.get(node.parent).children:roots).push(node);
 const sort=items=>{items.sort((a,b)=>a.name.localeCompare(b.name));for(const node of items)sort(node.children);};sort(roots);
 return {roots,nodes};
}

export function folderTreeMatches(nodes,query){
 const visible=new Set(),opened=new Set();
 const value=query.trim().toLocaleLowerCase();
 if(!value)return {visible:new Set(nodes.keys()),opened};
 for(const node of nodes.values())if(node.path.toLocaleLowerCase().includes(value)){
  visible.add(node.path);let parent=node.parent;
  while(parent){visible.add(parent);opened.add(parent);parent=nodes.get(parent).parent;}
 }
 return {visible,opened};
}

export function folderRuleState(path,local,common,contains,localCase,commonCase){
 const matching=(rules,sensitive)=>[...rules].filter(root=>contains(root,path,sensitive)).sort((a,b)=>a.length-b.length)[0];
 const localRoot=matching(local,localCase),commonRoot=matching(common,commonCase);
 const localParent=localRoot&&!contains(path,localRoot,localCase)?localRoot:null;
 const commonParent=commonRoot&&!contains(path,commonRoot,commonCase)?commonRoot:null;
 return {localParent,commonParent,cloud:!commonRoot,local:!commonRoot&&!localRoot};
}

export function setFolderIncluded(rules,path,included,contains,sensitive){
 for(const root of rules)if(contains(root,path,sensitive)&&contains(path,root,sensitive))rules.delete(root);
 if(!included)rules.add(path);
}
