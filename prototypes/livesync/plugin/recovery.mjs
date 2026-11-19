/** A settled failed Continuous operation has no owner to retry it upstream.
 * Retry through admission, never through private controllers or data rebuilds. */
export async function nativeConnectionReachable(request,url,headers,timeoutMs=8000) {
 let timeout;
 try {
  // requestUrl does not support AbortSignal. Bound the probe's wait and ignore
  // late completion; never treat an HTTP/auth failure as a reachable connection.
  return await Promise.race([
   Promise.resolve().then(()=>request(url,{headers})).then(response=>response.ok,()=>false),
   new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),timeoutMs);})
  ]);
 }finally{clearTimeout(timeout);}
}

export function desktopNetworkSignature(load) {
  try {
    const interfaces = load('os').networkInterfaces();
    return JSON.stringify(Object.entries(interfaces).flatMap(([name, addresses]) =>
      addresses.filter(address => !address.internal).map(address =>
        JSON.stringify([name, address.family, address.address, address.scopeid ?? null]))).sort());
  } catch {
    return undefined;
  }
}

export async function withConnectionTimeout(operation, timeoutMs = 15000) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('ERR_TIMED_OUT')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createRecoveryLoop(host) {
  let disposed = false, busy = false;
  let outageGeneration = 0, recoveredGeneration = 0;
  let attempts = 0, lastOutcome = null;
  return {
    get status() { return { busy, unavailable: outageGeneration !== recoveredGeneration, attempts, lastOutcome }; },
    markUnavailable() { outageGeneration++; },
    dispose() { disposed = true; },
    async tick() {
      if (disposed || busy || !host.eligible()) return;
      busy = true;
      const generation = outageGeneration;
      try {
        const reachable = await host.reachable();
        if (disposed || generation !== outageGeneration) return;
        if (!reachable) { outageGeneration++; return; }
        if (!host.eligible()) return;
        if (generation !== recoveredGeneration) {
          // Settings reapplication is the public lifecycle transition that retires
          // a transport owner left waiting on an obsolete long-poll connection.
          await host.resume();
          recoveredGeneration = generation;
        }
        if (disposed || generation !== outageGeneration || !host.eligible()) return;
        attempts++;
        lastOutcome = await host.start();
      } catch { lastOutcome = { status: 'failed' }; }
      finally { busy = false; }
    },
  };
}

// Replay durable tombstones whose filesystem projection was interrupted.
export function createPendingDeletionRecovery({eligible,files,metadata,apply,current,report}) {
 let running=false,completed;
 return async()=>{
  if(running||!eligible()||completed===current())return;
  running=true;
  const identity=current();
  try{
   for(const path of files()){
    if(!eligible()||current()!==identity)return;
    const doc=await metadata(path);
    if(!doc||!doc.deleted&&!doc._deleted)continue;
    if(!eligible()||current()!==identity)return;
    await apply(path);
   }
   completed=identity;
  }catch(error){report(error);}
  finally{running=false;}
 };
}
