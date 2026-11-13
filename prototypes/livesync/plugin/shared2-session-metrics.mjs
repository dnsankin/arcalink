/** Ephemeral display-only counters. Fetch body chunks are decoded bytes consumed
 * by the replication engine, not wire bytes and not a progress denominator. */
export function createShared2SessionMetrics({now=Date.now}={}){
 let bytes=0,applied=0,firstByte=null,lastProgress=null;
 return {
  read(count){if(!Number.isSafeInteger(count)||count<=0)return;const time=now();if(firstByte===null)firstByte=time;bytes+=count;lastProgress=time;},
  applied(){applied++;lastProgress=now();},
  snapshot(){const time=now(),elapsed=firstByte===null?0:Math.max(0,time-firstByte);return {bytes,applied,lastProgress,bytesPerSecond:elapsed>0?bytes*1000/elapsed:null};},
 };
}
