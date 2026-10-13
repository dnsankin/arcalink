import {parameterFailure} from './diagnostic.mjs';

export const STARTUP_NOTICE_GRACE_MS=15000;
export const startupConnectionMessage='Не удалось подключить синхронизацию. Проверьте интернет. ArcaLink продолжит попытки подключения.';
const transientMessages=[
 /^(?:Replication has been cancelled by some module failure|Replicator\.Message\.SomeModuleFailed|Some module has prevented the database from being ready\.|Replication (?:callback error|error)|Active replicator not found during directional )/,
 /^(?:Connection failure detected:|Network Error:|Network is offline$|No internet connection$|Failed to fetch(?: by API\.)?|Server is not available$|(?:The server is|Server) temporarily unavailable\.|Could not reach (?:the server|ArcaLink)\.|Could not connect to the server\.)/,
 /^(?:Error while opening P2P connection|The managed P2P room could not be prepared or opened\.|No peers has been detected, waiting incoming other peers\.\.\.|P2P Sync replicator is not found, possibly not have been configured or enabled\.)/,
 /^Synchronisation paused\. Your local notes are preserved\. Could not prepare synchronisation\./,
];

// Match known transient engine messages, never arbitrary failures: local data,
// encryption, account access and user actions must remain immediately visible.
export function isStartupConnectionNotice(message,translate=message=>message) {
 if(typeof message!=='string')return false;
 const raw=message.replace(/^(?:(?:\[[^\]\n]+\]\s*)|(?:\(\d+\):\s*)|(?:⚠️\s*))+/u,'').trim();
 if(raw===parameterFailure)return true;
 const english=translate(raw,'en');
 if(/\b(?:401|403|unauthori[sz]ed|forbidden|credentials|passphrase|encryption|decrypt|KeyValueDB)\b/i.test(english))return false;
 return transientMessages.some(pattern=>pattern.test(english));
}

export function startupConnectionStillFailed(state,backgroundErrors=[]) {
 if(!state.configured||!state.enabled||state.paused)return false;
 if(!state.online||state.errors.length)return true;
 // Free may be waiting for a peer. Only the signalling connection matters here.
 if(state.free)return !state.connected;
 if(state.ready&&/^(CONNECTED|COMPLETED|PAUSED|JOURNAL_SEND|JOURNAL_RECEIVE)$/.test(state.status))return false;
 return !!backgroundErrors.length||!state.ready||/ERRORED|FAILED|NOT_CONNECTED|CLOSED/.test(state.status);
}

export function createStartupNoticeGate({enabled,readState,notify,translate,now=Date.now,
 schedule=setTimeout,cancel=clearTimeout,graceMs=STARTUP_NOTICE_GRACE_MS}) {
 const deadline=now()+graceMs,background=new Map();
 let timer,disposed=false;
 const waiting=()=>enabled&&!disposed&&now()<deadline;
 const flush=async()=>{
  timer=undefined;
  let failed;
  try{
   const state=await readState();
   // A specific persistent error is already shown immediately. Do not add a
   // misleading connection warning on top of an access or local-data failure.
   failed=!state.errors.some(message=>!isStartupConnectionNotice(message,translate))
    &&startupConnectionStillFailed(state,[...background.values()]);
  }
  catch{failed=true;}
  if(!disposed&&failed)notify(startupConnectionMessage);
  background.clear();
 };
 const gate={
  defer(message){
   if(!waiting()||!isStartupConnectionNotice(message,translate))return false;
   if(timer===undefined)timer=schedule(()=>void flush(),Math.max(0,deadline-now()));
   return true;
  },
  record(source,message){
   background.delete(source);
   if(!gate.defer(message))return false;
   background.set(source,message);return true;
  },
  clear(source){background.delete(source);},
  dispose(){disposed=true;if(timer!==undefined)cancel(timer);timer=undefined;background.clear();}
 };
 return gate;
}
