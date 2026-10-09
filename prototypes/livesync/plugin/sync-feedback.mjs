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
export function syncLampState({errors,status,offline,paused,automaticOff}) {
 return errors.length||/ERRORED|FAILED/.test(status)?'error':offline?'offline':paused?'idle':/STARTED|JOURNAL/.test(status)?'active':automaticOff?'idle':/CONNECTED|PAUSED|COMPLETED/.test(status)?'ready':'idle';
}
