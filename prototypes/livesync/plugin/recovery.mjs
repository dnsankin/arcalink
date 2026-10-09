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
  let disposed = false, busy = false, unavailable = false;
  let attempts = 0, lastOutcome = null;
  return {
    get status() { return { busy, unavailable, attempts, lastOutcome }; },
    dispose() { disposed = true; },
    async tick() {
      if (disposed || busy || !host.eligible()) return;
      busy = true;
      try {
        const reachable = await host.reachable();
        if (disposed || !host.eligible()) return;
        if (!reachable) { unavailable = true; return; }
        if (unavailable) {
          unavailable = false;
          // Settings reapplication is the public lifecycle transition that retires
          // a transport owner left waiting on an obsolete long-poll connection.
          await host.resume();
        }
        if (disposed || !host.eligible()) return;
        attempts++;
        lastOutcome = await host.start();
      } catch { lastOutcome = { status: 'failed' }; }
      finally { busy = false; }
    },
  };
}
