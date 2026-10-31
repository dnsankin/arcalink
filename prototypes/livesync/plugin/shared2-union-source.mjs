const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Remote leaves are authoritative; keep locally available ancestor bodies that
 * normal replication did not upload. Neither source is mutated during merging. */
export function createShared2UnionSource(local,remote){
 return {
  identity:async()=>JSON.stringify([await local.identity(),await remote.identity()]),
  info:async()=>({update_seq:{local:(await local.info()).update_seq,remote:(await remote.info()).update_seq}}),
  async *groups(kind){const cache=new Map();for await(const group of local.groups(kind))cache.set(group.id,group);for await(const group of remote.groups(kind)){const other=cache.get(group.id);cache.delete(group.id);if(other&&other.leaves.some(revision=>!group.leaves.includes(revision)))throw fail('shared2-migration-cache-not-converged');yield {...group,localGroup:other,remoteGroup:group};}if(cache.size)throw fail('shared2-migration-cache-not-converged');},
  async *revisions(group){const localIds=new Set(group.localGroup?await local.revisionIds(group.localGroup):[]),remoteIds=new Set(await remote.revisionIds(group.remoteGroup));for(const revision of [...new Set([...localIds,...remoteIds])].sort((a,b)=>parseInt(a)-parseInt(b)||a.localeCompare(b))){
   let cached=localIds.has(revision)?await local.read(group.id,revision):null,server=remoteIds.has(revision)?await remote.read(group.id,revision):null;
   if(cached&&server){const {_revisions:left,...a}=cached,{_revisions:right,...b}=server;if(stable(a)!==stable(b)||left.start!==right.start||left.ids.slice(0,Math.min(left.ids.length,right.ids.length)).some((value,index)=>value!==right.ids[index]))throw fail('shared2-migration-history-disagrees');yield left.ids.length>=right.ids.length?cached:server;}
   else yield cached||server;
  }},
 };
}
