import {readAction,readActionDescriptor,applyCheckboxIntent,actionHash} from './companion-action-outbox.mjs';
import {createPeerActionCodec} from './companion-peer-action-codec.mjs';
import {createPeerActionReceiver} from './companion-peer-action-receiver.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Dispatch only an already authenticated, fully staged outbox action. The caller
 * supplies a scoped registry and file store; raw proposal/documents are never RPC input. */
export function createPeerActionDispatch({plugin,host,registry,journalDb,store,assertSession,verifyStaged,predecessor}){
 if(!plugin?.core?.services?.replicator||!host||!journalDb||typeof registry?.get!=='function'||typeof store!=='function'||typeof assertSession!=='function'||typeof verifyStaged!=='function')throw fail('action-dispatch-invalid');
 return async function dispatch({grantId,peerId,operationId,key,recoverOnly=false}){
  if(!token(grantId)||!token(peerId)||!token(operationId)||!hash(key))throw fail('action-dispatch-invalid');
  const grant=await registry.get(grantId),identity={schema:2,mode:'p2p',accountId:grant.account,workspaceId:grant.workspace,vaultId:grant.sourceVaultId,receiverId:grant.receiverId,ledgerEpoch:grant.ledgerEpoch,operationId};
  if(await verifyStaged(identity,key)!==true)throw fail('action-staging-invalid');
  const header=await readActionDescriptor(store(identity),identity,key),intent=header.intent;
  if(await verifyStaged(identity,key)!==true)throw fail('action-staging-invalid');
  return plugin.core.services.replicator.runWithActiveReplicatorContext(async context=>{
   if(context?.replicator?.rawHost!==host)throw fail('action-binding-changed');
   const core=plugin.core,services=core.services,db=services.database?.localDatabase?.localDatabase,settings=structuredClone(services.setting.currentSettings());
   const check=async()=>{const current=await registry.get(grantId);return await assertSession(peerId,grantId)===true&&await verifyStaged(identity,key)===true&&plugin.core===core&&core.services===services&&context.replicator.rawHost===host&&JSON.stringify(current)===JSON.stringify(grant);};
   let target=null;
   const admit=async({operation})=>await check()&&operation?.operationId===operationId&&operation.intent===header.intentDigest&&operation.target?.path===intent.path&&(!target||JSON.stringify(operation.target)===JSON.stringify(target));
   const receiver=createPeerActionReceiver(plugin,{account:grant.account,workspace:grant.workspace,receiverId:grant.receiverId,ledgerEpoch:grant.ledgerEpoch,peerId,requireExisting:true,journalDb,assertCurrent:check,admit});
   if(!await check())throw fail('action-binding-changed');
   const recovered=await receiver.recover({operationId,intent:header.intentDigest});
   if(recovered){await receiver.compact({operationId,intent:header.intentDigest,target:recovered.target});return {state:'confirmed',path:recovered.target.path,resultHash:recovered.target.resultHash,receipt:recovered.receipt};}
   if(recoverOnly)return {state:'pending',code:'action-pending'};
   const configured=Number(settings.syncMaxSizeInMB),maxBytes=Math.min(256*1024*1024,configured>0?configured*1024*1024:256*1024*1024);
   if(header.size>maxBytes)throw fail('action-size-limit');
   await receiver.assertTarget({operationId,intent:header.intentDigest,target:{path:intent.path,resultHash:header.payloadHash,size:header.size}});
   const action=await readAction(store(identity),identity,key);let payload=action.payload;
   if(action.intentDigest!==header.intentDigest||await verifyStaged(identity,key)!==true)throw fail('action-staging-invalid');
   if(intent.kind==='set-checkbox'){
    let before;try{before=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);}catch{throw fail('action-checkbox-encoding');}
    payload=new TextEncoder().encode(await applyCheckboxIntent(before,intent));
   }
   target={path:intent.path,resultHash:await actionHash(payload),size:payload.length};
   const request={operationId,intent:header.intentDigest,target};
   let state=await receiver.status(request);
   if(!state){
    if(intent.predecessor){if(typeof predecessor!=='function')throw fail('action-predecessor-pending');const prior=await predecessor(grant,intent.predecessor);if(prior?.state!=='confirmed'||prior.path!==intent.path||prior.resultHash!==intent.baseHash)throw fail('action-predecessor-pending');}
    const codec=await createPeerActionCodec({db,settings,admit:async path=>{if(path!==target.path)throw fail('action-binding-changed');await receiver.assertTarget(request);}});
    try{const binding={account:grant.account,workspace:grant.workspace,receiverId:grant.receiverId,ledgerEpoch:grant.ledgerEpoch,operationId,intent:header.intentDigest};
     const proposal=await codec.prepare(intent.path,payload,intent.kind==='create'?null:intent.baseHash,intent.createdAt,binding);
     state=await receiver.prepare({...request,proposal});
    }finally{await codec.close();}
   }
   if(state.phase==='prepared'||state.phase==='metadata-present')state=await receiver.commit(request);
   if(state.phase==='confirmed'){await receiver.compact(request);return {state:'confirmed',path:target.path,resultHash:target.resultHash,receipt:state.receipt};}
   return {state:state.phase==='conflict'?'conflict':'pending',code:state.phase==='conflict'?'action-remote-conflict':'action-pending'};
  });
 };
}
