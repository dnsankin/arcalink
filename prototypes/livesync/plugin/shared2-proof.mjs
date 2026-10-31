const fail=()=>Object.assign(Error('shared2-invalid-migration-attestation'),{code:'shared2-invalid-migration-attestation'});
const fields=['protocol','job','operation','owner','device','workspace','folder','nonce','source','sourceGeneration','sourceKeyEpoch','sourceSequenceDigest','sourceCipherDigest','target','targetGeneration','targetKeyEpoch','targetSequenceDigest','targetCipherDigest','contentProofDigest'];
export function checkedShared2Proof(value){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==[...fields].sort().join(',')||value.protocol!==2||!['share','unshare','encrypt','rotate','restore'].includes(value.operation))throw fail();
 for(const field of ['owner','device','workspace'])if(typeof value[field]!=='string'||!(/^[A-Za-z0-9-]{1,80}$/).test(value[field]))throw fail();
 for(const field of ['job','folder'])if(typeof value[field]!=='string'||!(/^[a-f0-9]{32}$/).test(value[field]))throw fail();
 for(const field of ['nonce','sourceSequenceDigest','sourceCipherDigest','targetSequenceDigest','targetCipherDigest','contentProofDigest'])if(typeof value[field]!=='string'||!(/^[a-f0-9]{64}$/).test(value[field]))throw fail();
 for(const field of ['source','target'])if(typeof value[field]!=='string'||!(/^arcalink_[ps]_[a-f0-9]{32}$/).test(value[field]))throw fail();
 for(const field of ['sourceGeneration','sourceKeyEpoch','targetGeneration','targetKeyEpoch'])if(!Number.isSafeInteger(value[field])||value[field]<0||field.endsWith('Generation')&&value[field]<1)throw fail();
 if(value.source===value.target)throw fail();return Object.fromEntries([...fields].sort().map(field=>[field,value[field]]));
}
export function shared2ProofBytes(value){return new TextEncoder().encode(JSON.stringify(checkedShared2Proof(value)));}
export const shared2ProofSignature=signature=>{let text='';for(const byte of new Uint8Array(signature))text+=String.fromCharCode(byte);return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
