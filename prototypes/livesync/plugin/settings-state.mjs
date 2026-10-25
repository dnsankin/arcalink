import {isFreeRelayConnection} from './free-relay-settings.mjs';

// Capabilities come from the server, never from the presence of saved fields.
// null means not checked yet; a network error must not invent a downgrade.
/** @param {{settings?:any,policy?:any,account?:any,signedIn?:boolean,telegram?:boolean,desktop?:any,shared?:boolean,publications?:boolean}} input */
export function settingsState({settings={},policy,account,signedIn=false,telegram=false,desktop={},shared=false,publications=false}={}) {
 const free=isFreeRelayConnection(settings)||policy?.sync_mode==='relay';
 const active=['active','trial','trialing'].includes(account?.billing_status);
 const knownPlan=['free','begin','personal_cloud','pro','solo','team'].includes(account?.plan);
 const cloud=free?false:typeof policy?.writable==='boolean'?policy.writable:knownPlan&&account?.billing_status?active:null;
 const pro=free?false:typeof policy?.paid==='boolean'?policy.paid:knownPlan&&account?.billing_status?active&&!['free','begin'].includes(account.plan):null;
 /** @type {Record<string,boolean|null>} */
 const capabilities={cloud,collaboration:pro};
 const configured={publications:publications===true,account:signedIn,vaults:!!settings.isConfigured,sync:!!settings.isConfigured&&!!(settings.liveSync||settings.syncInternalFiles||(free&&settings.P2P_AutoSyncPeers)),sharing:shared,telegram:telegram===true,desktop:!!(desktop.tray||desktop.closeToTray||desktop.globalHotkeys)};
 /** @type {Record<string,string>} */
 const sections={};
 for(const [id,value] of Object.entries(configured)) {
  const available=id==='sharing'?pro:id==='telegram'?cloud:true;
  sections[id]=available===false?'unavailable':value?'configured':'unconfigured';
 }
 return {capabilities,sections};
}

export function settingsStateLabel(state) {
 return state==='configured'?'Настроено':state==='unavailable'?'Недоступно на текущем тарифе':'';
}
export function capabilityHint(capability) {
 return capability==='collaboration'?'Создание совместных заметок, общих папок и приглашений доступно на Pro. Сохранённые материалы и управление доступом остаются на месте.':'Для этой функции нужен тариф с серверным хранилищем. Сохранённые настройки остаются на месте.';
}
