const clone=value=>JSON.parse(JSON.stringify(value));
const failure=code=>Object.assign(Error(code),{code});
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

/** Two checksummed slots: a torn/failed write never replaces the last valid state. */
export function createFolderPolicyStore(adapter,base) {
  let queue=Promise.resolve();
  async function load(){
    const valid=[];let present=false;
    for(const slot of ['a','b']){
      const file=base+'.'+slot+'.json';
      if(!await adapter.exists(file))continue;
      present=true;
      try{
        const row=JSON.parse(await adapter.read(file));
        if(row.protocol!==1||!Number.isSafeInteger(row.sequence)||row.sequence<1||typeof row.data!=='string'
          ||row.sha256!==await digest(row.sequence+':'+row.data))continue;
        const payload=JSON.parse(row.data);
        if(!payload||typeof payload!=='object'||Array.isArray(payload))continue;
        valid.push({sequence:row.sequence,payload,slot});
      }catch{/* A valid other slot can survive an interrupted write. */}
    }
    if(!valid.length){if(present)throw failure('folder-policy-store-unreadable');return {sequence:0,payload:{},slot:'b'};}
    valid.sort((a,b)=>b.sequence-a.sequence);
    if(valid.length===2&&valid[0].sequence===valid[1].sequence&&JSON.stringify(valid[0].payload)!==JSON.stringify(valid[1].payload))throw failure('folder-policy-store-conflicted');
    return valid[0];
  }
  const read=()=>queue.then(async()=>clone((await load()).payload));
  function update(change){
    const job=queue.then(async()=>{
      const current=await load(),payload=await change(clone(current.payload));
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||current.sequence>=Number.MAX_SAFE_INTEGER)throw failure('invalid-folder-policy-store');
      const sequence=current.sequence+1,data=JSON.stringify(payload),slot=current.slot==='a'?'b':'a';
      const row={protocol:1,sequence,data,sha256:await digest(sequence+':'+data)};
      const encoded=JSON.stringify(row);await adapter.write(base+'.'+slot+'.json',encoded);
      if(await adapter.read(base+'.'+slot+'.json')!==encoded)throw failure('folder-policy-store-write-failed');
      return clone(payload);
    });
    queue=job.catch(()=>{});return job;
  }
  return {read,update};
}
