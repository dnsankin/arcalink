import {CompanionActionCodec} from './companion-action-codec';
import {createLocalPouchFetch,LOCAL_ACTION_ORIGIN,LOCAL_ACTION_DATABASE} from './companion-action-local-pouch.mjs';
import {safeCompanionPath} from './companion-proof.mjs';
const fail=(code:string)=>Object.assign(Error(code),{code});
/** The caller supplies raw local Pouch, current vault codec settings and fresh scope admission. */
export function createReceiverProposalVerifier({db,settings,admit}:{db:any,settings:any,admit:(path:string)=>Promise<void>}){
 if(!db||!settings||typeof admit!=='function')throw fail('action-local-adapter-invalid');
 return async ({target,proposal}:any)=>{
  if(!target||!safeCompanionPath(target.path)||!/^[a-f0-9]{64}$/.test(target.resultHash)||!Number.isSafeInteger(target.size)||target.size<0||target.size>256*1024*1024||!proposal||!Array.isArray(proposal.chunks))throw fail('action-target-invalid');
  await admit(target.path);
  const local={...settings,couchDB_URI:LOCAL_ACTION_ORIGIN,couchDB_DBNAME:LOCAL_ACTION_DATABASE,couchDB_USER:'local',couchDB_PASSWORD:'local'};
  const fetcher=createLocalPouchFetch(db);const codec=new CompanionActionCodec(local,fetcher,admit);
  const revisions=new Map<string,{rev:string,data:string}>();let checked=false;
  try{
   await codec.open();
   await codec.verify(proposal,target.path,target.resultHash,true,target.size,async meta=>{
    const eden=meta.eden??{};if(!Array.isArray(meta.children)||typeof eden!=='object'||Array.isArray(eden))throw fail('action-chunks-invalid');
    const ids=[...new Set<string>(meta.children.filter((id:any)=>typeof id==='string'&&!Object.prototype.hasOwnProperty.call(eden,id)))];
    if(meta.children.some((id:any)=>typeof id!=='string'||!id.startsWith('h:'))||JSON.stringify([...ids].sort())!==JSON.stringify([...proposal.chunks].sort()))throw fail('action-chunks-invalid');
    for(const id of ids){let leaves;try{leaves=await db.get(id,{open_revs:'all'});}catch(error:any){if(error.status===404)throw fail('action-chunk-unavailable');throw error;}if(!Array.isArray(leaves)||leaves.length!==1||!leaves[0].ok||leaves[0].ok._deleted||leaves[0].ok.type!=='leaf')throw fail('action-chunk-unavailable');
     const chunk=leaves[0].ok,before=revisions.get(id);
     if(checked&&(!before||before.rev!==chunk._rev||before.data!==chunk.data))throw fail('action-chunk-changed');
     if(!checked)revisions.set(id,{rev:chunk._rev,data:chunk.data});
    }
    checked=true;
   });
   await admit(target.path);return true;
  }finally{fetcher.close();await codec.close();}
 };
}
