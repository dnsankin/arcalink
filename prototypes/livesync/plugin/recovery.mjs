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
