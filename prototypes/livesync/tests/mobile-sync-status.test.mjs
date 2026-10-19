import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileSyncState} from '../plugin/mobile-sync-state.mjs';
import {createMessageTranslator} from '../plugin/message-language.mjs';
import catalog from '../plugin/message-catalog.mjs';
const cloud={configured:true,ready:true,kind:'ready',status:'CONNECTED',sent:5,arrived:8};
test('a connection never claims that every file is synced',()=>{
 const state=mobileSyncState(cloud);assert.equal(state.label,'Подключено');assert.match(state.detail,/не подтверждение передачи всех файлов/);
 assert.deepEqual(state.counters,{sent:5,arrived:8});
});
test('startup and an unconfigured vault are distinct from a working connection',()=>{
 assert.equal(mobileSyncState({...cloud,configured:false}).label,'Подключите хранилище');
 assert.equal(mobileSyncState({...cloud,ready:false}).label,'Запуск синхронизации');
 assert.equal(mobileSyncState({...cloud,kind:'active',status:'STARTED'}).kind,'active');
});
test('offline, closed transport, pause and manual sync while auto-sync is off are distinct',()=>{
 assert.equal(mobileSyncState({...cloud,offline:true}).kind,'offline');
 for(const status of ['NOT_CONNECTED','CLOSED'])assert.equal(mobileSyncState({...cloud,kind:'idle',status}).label,'Нет связи');
 assert.equal(mobileSyncState({...cloud,paused:true}).label,'Приостановлено');
 assert.equal(mobileSyncState({...cloud,automaticOff:true}).label,'Автообмен выключен');
 assert.equal(mobileSyncState({...cloud,automaticOff:true,kind:'active'}).label,'Идёт синхронизация');
});
test('a confirmed failure takes precedence over a green transport and keeps raw errors out of the view model',()=>{
 for(const extra of [{kind:'error'},{errors:['HTTP 500 https://private/server TypeError: secret']}]){
  const s=mobileSyncState({...cloud,...extra});assert.equal(s.kind,'error');assert.doesNotMatch(JSON.stringify(s),/private|secret|HTTP|TypeError/);
 }
});
test('Free distinguishes signalling, peers and completed-file claims; no stale cloud counters',()=>{
 const free={...cloud,free:true,connected:false,peers:0};
 assert.equal(mobileSyncState(free).kind,'offline');
 assert.equal(mobileSyncState({...free,connected:true}).label,'Ожидаем второе устройство');
 const connected=mobileSyncState({...free,connected:true,peers:1});assert.equal(connected.label,'Устройство подключено');
 assert.match(connected.detail,/не подтверждает/);assert.equal(connected.counters,null);
});
test('session counters reject invalid values and are never shown before a vault is configured',()=>{
 for(const value of [NaN,Infinity,-1,'15',undefined])assert.equal(mobileSyncState({...cloud,sent:value}).counters,null);
 assert.deepEqual(mobileSyncState({...cloud,sent:0,arrived:2.9}).counters,{sent:0,arrived:2});
 assert.equal(mobileSyncState({...cloud,configured:false}).counters,null);
});
test('mobile labels and guidance translate to English without changing counts',()=>{
 const translate=createMessageTranslator(catalog);
 for(const input of [{},{...cloud},{...cloud,ready:false},{...cloud,offline:true},{...cloud,paused:true},{...cloud,kind:'error'},{...cloud,kind:'active'},{...cloud,automaticOff:true},{...cloud,kind:'idle'},{...cloud,kind:'idle',status:'CLOSED'},...Array.from({length:3},(_,i)=>({...cloud,free:true,connected:i>0,peers:i>1?1:0}))]){
  const state=mobileSyncState(input);for(const text of [state.label,state.detail]){assert.doesNotMatch(translate(text,'en'),/[А-Яа-яЁё]/);assert.equal(translate(translate(text,'en'),'ru'),text);}
 }
});
