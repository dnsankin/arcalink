// Already pinned by the upstream AWS SDK (sha256-js 5.2.0). Incremental hashing
// avoids loading complete videos into a JavaScript ArrayBuffer. No new package.
import {Sha256} from '@aws-crypto/sha256-js';
export async function hashShared2Stream(stream){
 const hash=new Sha256();let size=0;
 for await(const chunk of stream){if(!(chunk instanceof Uint8Array))throw Error('shared2-invalid-byte-stream');hash.update(chunk);size+=chunk.byteLength;if(!Number.isSafeInteger(size))throw Error('shared2-file-size-overflow');}
 return {size,sha256:[...await hash.digest()].map(value=>value.toString(16).padStart(2,'0')).join('')};
}
