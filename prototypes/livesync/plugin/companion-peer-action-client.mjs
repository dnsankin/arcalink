import {verifyActionSessionProof,actionSessionProof,createActionSession,actionFrameReference} from './companion-peer-action-session.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const nonce=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
/** One pinned receiver session; a failed request requires a fresh handshake. */
export async function openPeerActionClient({channel,peerId,sourcePeerId,grant,signal,timeoutMs=30000}){
 if(!channel||typeof channel.call!=='function'||!token(peerId)||!token(sourcePeerId)||!grant||!hex(grant.secret)||!['account','workspace','sourceVaultId','sourceDeviceId','receiverId','ledgerEpoch','grantId'].every(key=>token(grant[key])))throw fail('action-client-invalid');
 grant=structuredClone(grant);
 const sourceNonce=nonce(),hello=await channel.call(peerId,'action.hello',{step:'start',grantId:grant.grantId,sourceNonce},{signal,timeoutMs});
 const binding=hello?.binding;if(!binding||Object.keys(binding).sort().join(',')!=='account,grantId,ledgerEpoch,receiverId,receiverNonce,receiverPeerId,sourceDeviceId,sourceNonce,sourcePeerId,sourceVaultId,workspace'||['account','workspace','sourceVaultId','sourceDeviceId','receiverId','ledgerEpoch','grantId'].some(key=>binding[key]!==grant[key])||binding.sourcePeerId!==sourcePeerId||binding.receiverPeerId!==peerId||binding.sourceNonce!==sourceNonce||!await verifyActionSessionProof(grant.secret,'receiver',binding,hello.proof))throw fail('action-session-invalid');
 const proof=await actionSessionProof(grant.secret,'source',binding),ready=await channel.call(peerId,'action.hello',{step:'finish',grantId:grant.grantId,proof},{signal,timeoutMs});if(ready?.ready!==true)throw fail('action-session-invalid');
 const session=createActionSession(grant.secret,binding,'source');let closed=false,busy=false;
 return {async call(method,body){if(closed||busy||signal?.aborted)throw fail('action-session-invalid');busy=true;try{const request=await session.sign(method,body),response=await channel.call(peerId,'action.frame',request,{signal,timeoutMs}),frame=await session.verify(response);if(frame.method!=='result'||frame.reference!==await actionFrameReference(request))throw fail('action-frame-invalid');return frame.body;}catch(e){closed=true;session.close();throw e;}finally{busy=false;}},close(){closed=true;session.close();}};
}
