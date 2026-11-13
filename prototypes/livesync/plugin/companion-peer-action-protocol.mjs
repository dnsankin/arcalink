import {actionSessionProof,verifyActionSessionProof,createActionSession,actionFrameReference} from './companion-peer-action-session.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const nonce=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
/** Server handlers for the dedicated channel. authenticatePair must enforce the
 * pre-existing persistent peer decision; execute accepts only action operations. */
export function createPeerActionProtocol({registry,receiverPeerId,authenticatePair,execute,onSessionReset=()=>{},now=Date.now}){
 if(!registry||typeof registry.get!=='function'||!token(receiverPeerId)||typeof authenticatePair!=='function'||typeof execute!=='function'||typeof onSessionReset!=='function')throw fail('action-protocol-invalid');
 let closed=false;const sessions=new Map();
 const current=async state=>{if(closed||state.expires<=now()||sessions.get(state.peer)!==state)throw fail('action-session-expired');const grant=await registry.get(state.binding.grantId);if(closed||state.expires<=now()||sessions.get(state.peer)!==state||JSON.stringify(grant)!==JSON.stringify(state.grant))throw fail('action-session-invalid');return grant;};
 function sweep(){for(const [peer,state] of sessions)if(state.expires<=now()){state.session?.close();sessions.delete(peer);onSessionReset(peer);}}
 async function pair(peer,input,signal){if(closed||signal.aborted||!token(peer))throw fail('action-protocol-invalid');return authenticatePair(peer,input,signal);}
 async function hello(peer,input,signal){
  if(closed||signal.aborted||!token(peer)||!input||typeof input!=='object')throw fail('action-protocol-invalid');sweep();
  if(input.step==='start'){
   if(Object.keys(input).sort().join(',')!=='grantId,sourceNonce,step'||!token(input.grantId)||!hex(input.sourceNonce)||!sessions.has(peer)&&sessions.size>=8)throw fail('action-session-invalid');
   const grant=await registry.get(input.grantId);if(closed||signal.aborted)throw fail('action-session-invalid');
   const previous=sessions.get(peer);if(previous&&previous.binding.grantId!==input.grantId||!previous&&sessions.size>=8)throw fail('action-session-invalid');previous?.session?.close();sessions.delete(peer);if(previous)onSessionReset(peer);
   const binding={account:grant.account,workspace:grant.workspace,sourceVaultId:grant.sourceVaultId,sourceDeviceId:grant.sourceDeviceId,receiverId:grant.receiverId,ledgerEpoch:grant.ledgerEpoch,grantId:grant.grantId,sourcePeerId:peer,receiverPeerId,sourceNonce:input.sourceNonce,receiverNonce:nonce()};
   const state={peer,grant,binding,expires:now()+120000,session:null};sessions.set(peer,state);
   try{const proof=await actionSessionProof(grant.secret,'receiver',binding);await current(state);if(signal.aborted)throw fail('action-session-invalid');return {binding,proof};}catch(e){if(sessions.get(peer)===state)sessions.delete(peer);throw e;}
  }
  if(input.step==='finish'){
   if(Object.keys(input).sort().join(',')!=='grantId,proof,step'||!token(input.grantId)||!hex(input.proof))throw fail('action-session-invalid');
   const state=sessions.get(peer);if(!state||state.binding.grantId!==input.grantId||state.session||!await verifyActionSessionProof(state.grant.secret,'source',state.binding,input.proof))throw fail('action-session-invalid');
   await current(state);if(signal.aborted)throw fail('action-session-invalid');state.session=createActionSession(state.grant.secret,state.binding,'receiver');state.expires=now()+300000;return {ready:true};
  }throw fail('action-session-invalid');
 }
 async function frame(peer,input,signal){
  const state=sessions.get(peer);if(!state?.session||signal.aborted)throw fail('action-session-invalid');
  await current(state);const request=await state.session.verify(input);if(request.reference!==null)throw fail('action-frame-invalid');
  const reference=await actionFrameReference(request),result=await execute({grant:state.grant,peerId:peer,method:request.method,body:request.body,signal});
  await current(state);if(signal.aborted)throw fail('action-session-invalid');return state.session.sign('result',result,reference);
 }
 return {handlers:{'action.pair':pair,'action.hello':hello,'action.frame':frame},isCurrent:async(peer,grantId)=>{const state=sessions.get(peer);if(!state?.session||state.binding.grantId!==grantId)return false;try{await current(state);return true;}catch{return false;}},leave(peer){sessions.get(peer)?.session?.close();sessions.delete(peer);onSessionReset(peer);},close(){closed=true;for(const [peer,state] of sessions){state.session?.close();onSessionReset(peer);}sessions.clear();}};
}
