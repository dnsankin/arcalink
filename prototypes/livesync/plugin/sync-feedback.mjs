import {unsupportedVersionMessage} from './pilot-http.mjs';

export function folderSyncFailure(error) {
 const reason=error?.status===403&&error?.message===unsupportedVersionMessage?unsupportedVersionMessage
  :error?.status===401?'Повторно войдите в аккаунт в настройках ArcaLink.'
  :error?.status===403?'Нет доступа к синхронизации. Проверьте аккаунт в настройках ArcaLink. Если ошибка остаётся, обратитесь в поддержку.'
  :error?.status===429?'Сервер занят. Подождите немного и повторите синхронизацию.'
  :'Не удалось подготовить синхронизацию. Повторите попытку. Если ошибка остаётся, обратитесь в поддержку.';
 return 'Синхронизация приостановлена. Локальные заметки сохранены. '+reason;
}

// A confirmed preflight cause replaces only the engine's generic wrapper.
// Other modules' unresolved errors must remain visible.
export function syncUserMessages(errors,confirmed=[]) {
 const generic=new Set(['Replication has been cancelled by some module failure','Репликация отменена из-за сбоя модуля','Replicator.Message.SomeModuleFailed']);
 const withoutPrefix=message=>message.replace(/^(?:(?:\[[^\]\n]+\]\s*)|(?:\(\d+\):\s*)|(?:⚠️\s*))+/u,'').trim();
 return [...new Set([...confirmed,...errors.filter(message=>!confirmed.length||!generic.has(withoutPrefix(message)))])];
}

// A generic provider refusal is not evidence of a failed parameter request.
// Only the seed preflight may report parameterFailure; this reporter uses
// confirmed account/quota diagnostics and discards stale asynchronous results.
export function createSyncFeedback({diagnose,notify}) {
 let generation=0,message='',notice;
 return {
  get messages(){return message?[message]:[];},
  clear(){generation++;message='';notice?.hide();notice=undefined;},
  report(result,prominent=true){
   generation++;
   if(result!==message){notice?.hide();notice=undefined;message=result;}
   if(prominent&&!notice)notice=notify(result);
  },
  async failed(){
   const attempt=++generation,result=await diagnose();
   if(attempt!==generation||!result)return;
   this.report(result);
  }
 };
}
export function syncLampState({errors,status,offline,paused,automaticOff,active=false,sharedActive=false,sharedReady=false}) {
 if(offline)return 'offline';
 if(sharedActive)return 'active';
 if(sharedReady)return active?'active':'ready';
 if(paused)return 'idle';
 if(/ERRORED|FAILED/.test(status))return 'error';
 if(active||/STARTED|JOURNAL/.test(status))return 'active';
 if(automaticOff)return 'idle';
 if(/CONNECTED|PAUSED|COMPLETED/.test(status)&&status!=='NOT_CONNECTED')return 'ready';
 if(errors.length)return 'error';
 return ['NOT_CONNECTED','CLOSED'].includes(status)?'offline':'idle';
}

// Display-only samples. Cumulative counters establish a baseline, never activity by themselves.
export function createSyncActivityTracker({now=Date.now,holdMs=2000}={}) {
 let previous=null,until=0;
 return ({sent,arrived,counts=/** @type {number[]} */([])})=>{
  const stamp=now(),current=[sent,arrived];
  const changed=previous&&current.some((value,i)=>Number.isFinite(value)&&Number.isFinite(previous[i])&&value>previous[i]);
  if(changed||counts.some(value=>Number.isFinite(value)&&value>0))until=stamp+holdMs;
  previous=current;
  return stamp<until;
 };
}
