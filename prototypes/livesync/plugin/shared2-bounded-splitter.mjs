import {arrayBufferToBase64Single} from 'octagonal-wheels/binary';
/** Standard LiveSync leaf encoding with bounded input reads. Chunk boundaries
 * are local to shared2; metadata/leaf formats and hashes remain engine-native.
 * Avoid V1's whole-text read and V3's whole-file ArrayBuffer on mobile.
 */
export const SHARED2_CHUNK_BYTES=1024*1024;
export function installShared2BoundedSplitter(local){
 const splitter=local.managers?.splitter;if(typeof splitter?.splitContent!=='function')throw Error('shared2-splitter-unavailable');
 splitter.splitContent=async entry=>{
  const blob=entry.data;if(!(blob instanceof Blob))throw Error('shared2-splitter-blob-required');
  const plain=blob.type==='text/plain';
  return (async function*(){
   const decoder=plain?new TextDecoder('utf-8',{fatal:true}):null;
   for(let offset=0;offset<blob.size;offset+=SHARED2_CHUNK_BYTES){
    const bytes=new Uint8Array(await blob.slice(offset,offset+SHARED2_CHUNK_BYTES).arrayBuffer());
    if(plain){const text=decoder.decode(bytes,{stream:true});if(text)yield text;}
    else{try{yield await arrayBufferToBase64Single(bytes);}catch(error){if(typeof globalThis.Buffer?.from!=='function')throw error;yield globalThis.Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');}}
   }
   if(decoder){const last=decoder.decode();if(last)yield last;}
  })();
 };
}
