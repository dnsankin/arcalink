import {actionHash,applyCheckboxIntent,validateActionIntent,ACTION_MAX_BYTES} from './companion-action-outbox.mjs';

const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Both hosts use this runner. api is the authenticated action endpoint; codec
 * creates a fresh maintained codec per call, never a vault database or scanner.
 * An operation is always recovered before testing today's file base.
 */
export async function executeCompanionAction(action,{api,codec,admit,predecessor}){
 const {identity,intent,intentDigest}=action;
 validateActionIntent(intent);
 if(!identity||!['accountId','workspaceId','vaultId','operationId'].every(key=>token(identity[key]))||!digest(intentDigest)||!(action.payload instanceof Uint8Array)||action.payload.length>ACTION_MAX_BYTES)throw fail('action-invalid');
 let payload=action.payload.slice();
 if(intent.kind==='set-checkbox'){
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(payload);}catch{throw fail('action-checkbox-encoding');}
  payload=new TextEncoder().encode(await applyCheckboxIntent(source,intent));
 }
 const resultHash=await actionHash(payload),key={operationId:identity.operationId,intent:intentDigest};
 const check=async()=>admit(identity,intent);
 const call=async(method,extra={})=>{await check();return (await api(method,{...key,...extra})).operation;};
 const inspect=value=>{
  if(!value||!['prepared','confirmed','conflict'].includes(value.phase)||!value.proposal?.document||typeof value.proposal.document._rev!=='string')throw fail('action-reply-invalid');
  if(value.phase!=='prepared'){
   const receipt=value.receipt;
   if(!receipt||receipt.operationId!==key.operationId||receipt.intent!==key.intent||receipt.outcome!==value.phase||receipt.documentId!==value.proposal.document._id||receipt.revision!==value.proposal.document._rev)throw fail('action-receipt-invalid');
  }
  return value;
 };
 const using=async(work)=>{const instance=await codec();try{await instance.open();return await work(instance);}finally{await instance.close();}};
 await check();
 let current=await call('status');
 if(current)inspect(current);
 if(current?.phase==='conflict')return {state:'conflict',code:'action-remote-conflict',receipt:current.receipt};
 if(current?.phase!=='confirmed'&&intent.predecessor){
  if(typeof predecessor!=='function')throw fail('action-predecessor-pending');
  const prior=await predecessor(intent.predecessor);
  if(prior?.state!=='confirmed'||prior.path!==intent.path||prior.resultHash!==intent.baseHash)throw fail('action-predecessor-pending');
 }
 if(!current){
  const proposal=await using(value=>value.prepare(intent.path,payload,intent.kind==='create'?null:intent.baseHash,intent.createdAt));
  current=inspect(await call('prepare',{proposal}));
 }
 if(current.phase==='prepared'){
  // Another executor may have won with a different randomized ciphertext.
  // Verify the selected proposal against OUR authenticated immutable action.
  await using(value=>value.verify(current.proposal,intent.path,resultHash,true));
  current=inspect(await call('commit'));
 }
 if(current.phase==='conflict')return {state:'conflict',code:'action-remote-conflict',receipt:current.receipt};
 if(current.phase!=='confirmed')throw fail('action-result-unconfirmed');
 await using(value=>value.verify(current.proposal,intent.path,resultHash,false));
 await check();
 return {state:'confirmed',receipt:current.receipt,resultHash,path:intent.path};
}
