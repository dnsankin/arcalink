import {canonicalOwnership,ownershipIdentity,validOwnershipIdentity} from './companion-ownership-model.mjs';
import {keyTransferComparison} from './companion-key-transfer.mjs';

export const BOOTSTRAP_PURPOSE='arcalink-companion-bootstrap-settings-v1';
const fail=()=>Object.assign(Error('Не удалось проверить автоматическое подключение Компаньона.'),{code:'companion-automatic-invalid'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
async function mac(secret,purpose,value){
 if(typeof secret!=='string'||secret.length<20||secret.length>4096)throw fail();
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(purpose+'\0'+canonicalOwnership(value))));
 return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function automaticRequestProof(request,secret,localVaultId,accepted=false){
 if(!validOwnershipIdentity(request)||request.phase!=='prepare'||!uuid(localVaultId))throw fail();
 await keyTransferComparison(request,accepted?request.keyTransfer.expiresAt-1:Date.now());
 return mac(secret,'arcalink-companion-bootstrap-request-v1',{...ownershipIdentity(request),phase:'prepare',localVaultId,keyTransfer:request.keyTransfer,...(request.automatic?.localSnapshot===1?{localSnapshot:1}:{})});
}
export async function verifyAutomaticRequest(request,session,localVaultId,accepted=false){
 const automatic=request?.automatic;
 if(!automatic||automatic.schema!==1||Object.keys(automatic).some(key=>!['schema','localVaultId','proof','localSnapshot'].includes(key))
  ||automatic.localSnapshot!==undefined&&automatic.localSnapshot!==1||automatic.localVaultId!==localVaultId||request.companionDeviceId!==session?.deviceId)throw fail();
 const expected=await automaticRequestProof(request,session.refreshToken,localVaultId,accepted);
 if(typeof automatic.proof!=='string'||automatic.proof.length!==64)throw fail();
 let difference=0;for(let i=0;i<64;i++)difference|=expected.charCodeAt(i)^automatic.proof.charCodeAt(i);
 if(difference)throw fail();return true;
}
export async function automaticEnvelopeProof(envelope,secret){
 const value={...envelope};delete value.proof;
 if(value.context?.purpose!==BOOTSTRAP_PURPOSE)throw fail();
 return mac(secret,'arcalink-companion-bootstrap-response-v1',value);
}
