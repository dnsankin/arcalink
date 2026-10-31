import {partitionShared2Source} from './shared2-partition.mjs';
import {rekeyShared2Graph} from './shared2-rekey.mjs';
import {planShared2ReverseUnion,selectedShared2RevisionTarget} from './shared2-reverse-union.mjs';
import {safeRelative} from './folder-model.mjs';
const fail=(code,review)=>Object.assign(Error(code),{code,...(review?{review}:{})});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
/** Internal forward-reconciliation building block. Only job-owned local caches
 * are written. P0/S0 remain untouched. Server freezing, P1 proof, three registered
 * receipts and joint publication are deliberately outside this primitive.
 */
export async function buildShared2AliasUnion({privateSource,sharedSource,baseTarget,aliasTarget,target,mount,job,approvedAliasIds=[],isCurrent=async()=>true}){
 if(!safeRelative(mount)||!/^[a-f0-9]{32}$/.test(job)||!Array.isArray(approvedAliasIds)||new Set(approvedAliasIds).size!==approvedAliasIds.length)throw fail('shared2-alias-union-scope');
 const inputs=[privateSource,sharedSource],views=[...inputs,baseTarget,aliasTarget,target];
 if(views.some(view=>!view||typeof view.identity!=='function')||new Set(await Promise.all(views.map(view=>view.identity()))).size!==views.length)throw fail('shared2-alias-union-distinct-caches-required');
 const sourceSequences=await Promise.all(inputs.map(async view=>(await view.info()).update_seq));
 async function current(){if(!await isCurrent()||(await Promise.all(inputs.map(view=>view.info()))).some((info,n)=>stable(info.update_seq)!==stable(sourceSequences[n])))throw fail('shared2-alias-union-source-changed');return true;}
 const codec=await Promise.all([baseTarget,aliasTarget,target].map(async view=>[await view.pathId(mount+'/ArcaLink alias codec check.md'),await view.chunkId('ArcaLink alias codec check')]));
 if(codec.some(value=>stable(value)!==stable(codec[0])))throw fail('shared2-alias-target-codec-mismatch');
 await current();const partition=await partitionShared2Source({source:privateSource,mount,isCurrent:current});
 for await(const group of sharedSource.groups('metadata'))for await(const doc of sharedSource.revisions(group)){await current();if(!doc._deleted&&(!safeRelative(doc.path)||!doc.path.toLowerCase().startsWith(mount.toLowerCase()+'/')))throw fail('shared2-alias-shared-path-outside-mount');}
 const original=await rekeyShared2Graph({source:sharedSource,target:baseTarget,job,isCurrent:current});
 const aliases=await rekeyShared2Graph({source:partition.view,target:aliasTarget,job,isCurrent:current});
 const sequences=await Promise.all([baseTarget,aliasTarget].map(async view=>(await view.info()).update_seq));
 async function frozen(){await current();if((await Promise.all([baseTarget,aliasTarget].map(view=>view.info()))).some((info,n)=>stable(info.update_seq)!==stable(sequences[n])))throw fail('shared2-alias-union-input-changed');return true;}
 const baseIds=new Set(),collisions=[];for await(const group of baseTarget.groups('metadata')){await frozen();baseIds.add(group.id);}for await(const group of aliasTarget.groups('metadata')){await frozen();if(baseIds.has(group.id))collisions.push(group.id);}collisions.sort();
 if(collisions.length&&!approvedAliasIds.length)throw fail('shared2-alias-union-review-required',{files:collisions.length,ids:collisions});
 if(stable([...approvedAliasIds].sort())!==stable(collisions))throw fail('shared2-alias-union-review-changed');
 await planShared2ReverseUnion({source:baseTarget,incoming:aliasTarget,metadataIds:collisions,mount,isCurrent:frozen});
 // Build the exact expected union from the TWO immutable inputs. A partially
 // imported output never becomes evidence for its own completeness on retry.
 const expected=new Map(),records=[[],[]];
 for(const [index,view] of [baseTarget,aliasTarget].entries())for(const kind of ['chunk','metadata'])for await(const group of view.groups(kind)){
  await frozen();const revisions=[];let entry=expected.get(group.id);if(!entry){entry={revisions:new Map(),leaves:new Set(),ancestors:new Set()};expected.set(group.id,entry);}for(const leaf of group.leaves)entry.leaves.add(leaf);
  for await(const body of view.revisions(group)){await frozen();const hash=await digest(body),old=entry.revisions.get(body._rev);if(old&&old!==hash)throw fail('shared2-alias-union-history-disagrees');entry.revisions.set(body._rev,hash);revisions.push(body._rev);const chain=body._revisions;if(!chain||!Array.isArray(chain.ids)||chain.start!==Number(body._rev.split('-')[0]))throw fail('shared2-alias-union-ancestry-missing');chain.ids.slice(1).forEach((hash,n)=>entry.ancestors.add((chain.start-n-1)+'-'+hash));}
  records[index].push({id:group.id,leaves:[...group.leaves],revisions});
 }
 await target.own(job,stable(await Promise.all(inputs.map(view=>view.identity()))),stable(sourceSequences));
 for(const view of [baseTarget,aliasTarget])for(const kind of ['chunk','metadata'])for await(const group of view.groups(kind))for await(const body of view.revisions(group)){await frozen();await target.importRevision(body);}
 await frozen();const targetSequence=(await target.info()).update_seq,seen=new Set();
 for(const kind of ['chunk','metadata'])for await(const group of target.groups(kind)){
  await frozen();const entry=expected.get(group.id);if(!entry||seen.has(group.id))throw fail('shared2-alias-union-extra-record');seen.add(group.id);const leaves=[...entry.leaves].filter(rev=>!entry.ancestors.has(rev)).sort();
  if(stable([...group.leaves].sort())!==stable(leaves))throw fail('shared2-alias-union-leaves-disagree');const revisions=new Set();for await(const body of target.revisions(group)){await frozen();if(entry.revisions.get(body._rev)!==await digest(body)||revisions.has(body._rev))throw fail('shared2-alias-union-history-disagrees');revisions.add(body._rev);}if(revisions.size!==entry.revisions.size)throw fail('shared2-alias-union-history-missing');
 }
 if(seen.size!==expected.size)throw fail('shared2-alias-union-record-missing');
 const sharedProof=await rekeyShared2Graph({source:sharedSource,target:selectedShared2RevisionTarget(target,records[0]),job,verifyOnly:true,isCurrent:frozen});
 const aliasProof=await rekeyShared2Graph({source:partition.view,target:selectedShared2RevisionTarget(target,records[1]),job,verifyOnly:true,isCurrent:frozen});
 if(sharedProof.contentProofDigest!==original.contentProofDigest||aliasProof.contentProofDigest!==aliases.contentProofDigest||(await target.info()).update_seq!==targetSequence)throw fail('shared2-alias-union-proof-changed');
 await frozen();return {partition,records,documents:expected.size,collisions,sharedProof,aliasProof};
}

/** Compare the COMPLETE decoded union, not just either projected source. */
export async function verifyShared2AliasUnionTarget({local,remote,isCurrent=async()=>true}){
 const views=[local,remote],sequences=await Promise.all(views.map(async view=>(await view.info()).update_seq));
 const current=async()=>{if(!await isCurrent()||(await Promise.all(views.map(view=>view.info()))).some((info,n)=>stable(info.update_seq)!==stable(sequences[n])))throw fail('shared2-alias-union-readback-changed');};
 const expected=new Map();
 for(const kind of ['chunk','metadata'])for await(const group of local.groups(kind)){await current();const bodies=new Map();for await(const doc of local.revisions(group)){await current();bodies.set(doc._rev,await digest(doc));}expected.set(group.id,{leaves:stable([...group.leaves].sort()),bodies});}
 const seen=new Set();
 for(const kind of ['chunk','metadata'])for await(const group of remote.groups(kind)){
  await current();const entry=expected.get(group.id);if(!entry||seen.has(group.id)||entry.leaves!==stable([...group.leaves].sort()))throw fail('shared2-alias-union-readback-record');seen.add(group.id);const revisions=new Set();
  for await(const doc of remote.revisions(group)){await current();if(revisions.has(doc._rev)||entry.bodies.get(doc._rev)!==await digest(doc))throw fail('shared2-alias-union-readback-revision');revisions.add(doc._rev);}if(revisions.size!==entry.bodies.size)throw fail('shared2-alias-union-readback-missing');
 }
 await current();if(seen.size!==expected.size)throw fail('shared2-alias-union-readback-missing');return {documents:seen.size};
}
