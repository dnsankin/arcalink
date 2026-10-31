import {createShared2MigrationView} from './shared2-migration-view.mjs';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
/** Owner-side raw ciphertext readback. Never decrypts outside files, writes,
 * switches authority or signs a receipt. The coordinator must bind its result to
 * server-observed job scopes before asking the registered device to sign. */
async function verifyPrivateReadback({source,target,removed,isCurrent},added,merged=[]){
 if(!Array.isArray(removed)||new Set(removed).size!==removed.length||removed.some(id=>typeof id!=='string'||!id||id.length>4096||id.startsWith('_'))||typeof isCurrent!=='function')throw fail('shared2-private-readback-scope');
 const before=await Promise.all([source.info(),target.info()]);
 if(before.some(info=>typeof info.db_name!=='string'||!/^arcalink_p_[a-f0-9]{32}$/.test(info.db_name))||before[0].db_name===before[1].db_name)throw fail('shared2-private-readback-scope');
 async function current(){
  if(!await isCurrent())throw fail('shared2-private-readback-cancelled');
  const now=await Promise.all([source.info(),target.info()]);
  if(now.some((info,index)=>info.db_name!==before[index].db_name||stable(info.update_seq)!==stable(before[index].update_seq)))throw fail('shared2-private-readback-changed');
 }
 async function parameters(database){try{const {_rev,...value}=await database.get('_local/obsidian_livesync_sync_parameters');return value;}catch(error){if(error.status===404)return null;throw error;}}
 await current();const originalParameters=await parameters(source),parameterHash=await digest(originalParameters);
 if(await digest(await parameters(target))!==parameterHash)throw fail('shared2-private-readback-parameters');
 async function observe(database){
  const rows=new Map(),view=createShared2MigrationView({localDatabase:database},{readOnly:true});let since=0;
  for(;;){await current();const page=await database.changes({since,limit:32,style:'all_docs',return_docs:true});if(!page.results.length)break;
   for(const row of page.results){
    if(row.id.startsWith('_')&&!row.id.startsWith('_design/'))continue;
    if(rows.has(row.id))throw fail('shared2-private-readback-changed');
    const group={id:row.id,leaves:row.changes.map(item=>item.rev)},revisions=[],available=new Set();
    for await(const body of view.revisions(group)){await current();if(body._id!==row.id||typeof body._rev!=='string'||!/^\d+-[^\s]+$/.test(body._rev)||available.has(body._rev))throw fail('shared2-private-readback-history');available.add(body._rev);revisions.push([body._rev,await digest(body)]);}
    if(!revisions.length||group.leaves.some(rev=>!revisions.some(item=>item[0]===rev)))throw fail('shared2-private-readback-history');
    rows.set(row.id,{leaves:[...group.leaves].sort(),revisions:revisions.sort(([a],[b])=>a<b?-1:a>b?1:0)});
   }
   if(stable(page.last_seq)===stable(since))throw fail('shared2-private-readback-stalled');since=page.last_seq;
  }
  return rows;
 }
 const expected=await observe(source);for(const id of removed)if(!expected.delete(id))throw fail('shared2-private-readback-selection');
 const actual=await observe(target),addedRecords=[];
 for(const identifier of added){
  if(expected.has(identifier)||!actual.has(identifier))throw fail('shared2-private-readback-addition');
  addedRecords.push([identifier,actual.get(identifier)]);actual.delete(identifier);
 }
 const mergedRecords=[];let mergedRetainedRevisions=0;
 for(const row of merged){
  const old=expected.get(row.id),next=actual.get(row.id);if(!old||!next)throw fail('shared2-private-readback-merge');
  const previous=new Map(old.revisions),observed=new Map(next.revisions),wanted=new Set([...previous.keys(),...row.revisions]);
  if(observed.size!==wanted.size||[...observed.keys()].some(rev=>!wanted.has(rev))||[...previous].some(([rev,hash])=>observed.get(rev)!==hash))throw fail('shared2-private-readback-merge');
  // Derive the union leaves from actual ancestry. Old leaves may become
  // ancestors, but their exact original bodies/hashes must remain available.
  const ancestors=new Set();for(const [rev] of next.revisions){await current();const body=await target.get(row.id,{rev,revs:true});if(!body._revisions||!Array.isArray(body._revisions.ids)||body._revisions.start!==Number(rev.split('-')[0])||rev!==body._revisions.start+'-'+body._revisions.ids[0])throw fail('shared2-private-readback-merge');body._revisions.ids.slice(1).forEach((hash,n)=>ancestors.add((body._revisions.start-n-1)+'-'+hash));}
  const leaves=[...new Set([...old.leaves,...row.leaves])].filter(rev=>!ancestors.has(rev)).sort();
  if(stable(leaves)!==stable(next.leaves))throw fail('shared2-private-readback-merge');
  mergedRetainedRevisions+=old.revisions.length;mergedRecords.push([row.id,next]);expected.delete(row.id);actual.delete(row.id);
 }
 if(expected.size!==actual.size||[...expected].some(([id,value])=>stable(value)!==stable(actual.get(id))))throw fail('shared2-private-readback-mismatch');
 await current();if(await digest(await parameters(source))!==parameterHash||await digest(await parameters(target))!==parameterHash)throw fail('shared2-private-readback-parameters');
 const retained=[...expected].sort(([a],[b])=>a<b?-1:a>b?1:0);
 return {contentProofDigest:await digest({protocol:2,source:before[0].db_name,target:before[1].db_name,sourceSequence:before[0].update_seq,targetSequence:before[1].update_seq,parameters:parameterHash,retained,...(added.length?{added:addedRecords.sort(([a],[b])=>a<b?-1:a>b?1:0)}:{}),...(merged.length?{merged:mergedRecords.sort(([a],[b])=>a<b?-1:a>b?1:0)}:{})}),documents:retained.length+mergedRecords.length,revisions:retained.reduce((total,[,value])=>total+value.revisions.length,0)+mergedRetainedRevisions};
}

/** Existing share proof remains exact: callers cannot opt out extra records. */
export function verifyShared2PrivateRemainder(options){return verifyPrivateReadback(options,[]);}

/** Reverse P0+S0 -> P1: additions must come from the independently verified
 * shared rekey, not from a server success flag. Never permits alteration or new
 * revision bodies of an existing private record. Explicit colliding chunks may
 * gain only the independently verified shared revisions, retaining old hashes.
 * Coordinator still requires the separate S0->P1 proof and a sealed target.
 */
export async function verifyShared2PrivateUnion({source,target,added,merged=[],metadataIds=[],isCurrent}){
 if(!Array.isArray(added)||new Set(added).size!==added.length||added.some(id=>typeof id!=='string'||!id||id.length>4096||id.startsWith('_')))throw fail('shared2-private-readback-addition');
 if(!Array.isArray(metadataIds)||new Set(metadataIds).size!==metadataIds.length||metadataIds.some(id=>typeof id!=='string'||!id||id.startsWith('_')||id.startsWith('h:')))throw fail('shared2-private-readback-merge');const metadata=new Set(metadataIds);
 if(!Array.isArray(merged)||new Set(merged.map(row=>row?.id)).size!==merged.length||merged.some(row=>!row||typeof row.id!=='string'||(!row.id.startsWith('h:')&&!(row.kind==='metadata'&&metadata.has(row.id)))||added.includes(row.id)||!Array.isArray(row.revisions)||!Array.isArray(row.leaves)||!row.leaves.length||!row.revisions.length||new Set(row.revisions).size!==row.revisions.length||new Set(row.leaves).size!==row.leaves.length||row.revisions.some(rev=>typeof rev!=='string'||!/^\d+-[^\s]+$/.test(rev))||row.leaves.some(rev=>!row.revisions.includes(rev))))throw fail('shared2-private-readback-merge');
 const result=await verifyPrivateReadback({source,target,removed:[],isCurrent},added,merged);return {...result,addedDocuments:added.length,mergedDocuments:merged.length};
}
