const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Completeness gate for explicit restoration of a purged authority. Ciphertext
 * hashes cannot be compared to decrypted local Pouch bodies. Require the exact
 * saved revision identities/leaf sets, then let the existing rekey/readback prove
 * every local plaintext byte independently. Missing history is never invented.
 */
export async function verifyShared2RetainedCache({source,inventory,isCurrent}){
 if(!inventory||Object.keys(inventory).sort().join(',')!=='documents,history'||![inventory.documents,inventory.history].every(value=>value&&typeof value==='object'&&!Array.isArray(value))||typeof isCurrent!=='function')throw fail('shared2-restore-inventory-invalid');
 const expected=new Map();
 for(const [id,leaves] of Object.entries(inventory.documents)){
  if(id.startsWith('_design/'))continue;
  const history=inventory.history[id]||{};
  if(!id||id.startsWith('_')||![leaves,history].every(value=>value&&typeof value==='object'&&!Array.isArray(value))||!Object.keys(leaves).length)throw fail('shared2-restore-inventory-invalid');
  const revisions=Object.keys({...history,...leaves});
  if(revisions.some(rev=>!/^\d+-[^\s]+$/.test(rev))||Object.values({...history,...leaves}).some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))||Object.keys(history).some(rev=>rev in leaves))throw fail('shared2-restore-inventory-invalid');
  expected.set(id,{leaves:Object.keys(leaves).sort(),revisions:revisions.sort()});
 }
 if(Object.keys(inventory.history).some(id=>!(id in inventory.documents)))throw fail('shared2-restore-inventory-invalid');
 const identity=await source.identity(),sequence=(await source.info()).update_seq,seen=new Set();let revisions=0;
 async function current(){if(!await isCurrent()||await source.identity()!==identity||stable((await source.info()).update_seq)!==stable(sequence))throw fail('shared2-restore-cache-changed');}
 await current();
 for(const kind of ['chunk','metadata'])for await(const group of source.groups(kind)){
  await current();const wanted=expected.get(group.id);
  if(!wanted||seen.has(group.id)||!Array.isArray(group.leaves)||stable([...group.leaves].sort())!==stable(wanted.leaves))throw fail('shared2-restore-cache-incomplete');seen.add(group.id);
  const available=[];for await(const body of source.revisions(group)){await current();if(body._id!==group.id||typeof body._rev!=='string'||available.includes(body._rev))throw fail('shared2-restore-cache-incomplete');available.push(body._rev);revisions++;}
  if(stable(available.sort())!==stable(wanted.revisions))throw fail('shared2-restore-cache-incomplete');
 }
 await current();if(seen.size!==expected.size)throw fail('shared2-restore-cache-incomplete');
 return {documents:seen.size,revisions,identity,sequence};
}
