/** Bound large Android reconstructions; keep different revisions/options independent. */
const owners=new WeakMap();
export function readLargeContent(owner,meta,options,mobile,task) {
 if(!mobile||!Number.isFinite(meta?.size)||meta.size<32*1024*1024)return task();
 let state=owners.get(owner);if(!state){state={tail:Promise.resolve(),pending:new Map()};owners.set(owner,state);}
 const key=JSON.stringify([meta._id,meta._rev ?? [meta.size,meta.children,meta.eden],options]);
 if(state.pending.has(key))return state.pending.get(key);
 const run=state.tail.catch(()=>{}).then(task);
 state.pending.set(key,run);
 const clear=()=>{if(state.pending.get(key)===run)state.pending.delete(key);};
 run.then(clear,clear);
 // Let previous consumers write/release their result before assembling another.
 state.tail=run.then(()=>{},()=>{}).then(()=>new Promise(resolve=>setTimeout(resolve,250)));
 return run;
}

/** Decode one independently encoded chunk at a time into a single output buffer. */
export async function assembleBinaryChunks(meta, read, decode) {
 const output=new Uint8Array(meta.size);let offset=0,legacy=false,index=0;
 for(const id of meta.children) {
  const chunks=await read([id]);
  if(chunks.length!==1||!chunks[0]||typeof chunks[0].data!=='string')throw Error('Missing binary chunk');
  const encoded=chunks[0].data;
  if(index===0)legacy=encoded.startsWith('%');
  const bytes=new Uint8Array(decode(legacy&&index>0?'%'+encoded:encoded));index++;
  if(offset+bytes.byteLength>output.byteLength)throw Error('Binary file exceeds recorded size');
  output.set(bytes,offset);offset+=bytes.byteLength;
 }
 if(offset!==output.byteLength)throw Error('Binary file size does not match metadata');
 return output.buffer;
}
