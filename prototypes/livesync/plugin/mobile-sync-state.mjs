// Presentation only: no replication, readiness checks, requests or retries.
export function mobileSyncState(input={}) {
 const result=(kind,label,detail)=>({kind,label,detail,free:!!input.free,
  counters:!input.free&&!!input.configured&&Number.isFinite(input.sent)&&input.sent>=0&&Number.isFinite(input.arrived)&&input.arrived>=0
   ?{sent:Math.floor(input.sent),arrived:Math.floor(input.arrived)}:null});
 if(input.kind==='error'||input.errors?.length)return result('error','Требуется внимание','Не удалось подтвердить синхронизацию. Проверьте сообщение ниже или откройте настройки.');
 if(!input.configured)return result('idle','Подключите хранилище','Войдите в аккаунт и выберите хранилище в настройках ArcaLink.');
 if(input.offline)return result('offline','Нет интернета','Проверьте подключение смартфона к интернету.');
 if(input.paused)return result('idle','Приостановлено','Синхронизация приостановлена. Проверьте её настройки.');
 if(input.free){
  if(!input.connected)return result('offline','Нет связи','Нет подключения для обмена между устройствами. Проверьте интернет и настройки ArcaLink.');
  if(!input.peers)return result('idle','Ожидаем второе устройство','Откройте Obsidian с этим хранилищем на другом устройстве. Для Free оба устройства должны быть онлайн.');
  return result('ready','Устройство подключено','Второе устройство доступно. Наличие связи не подтверждает завершение передачи всех файлов.');
 }
 if(!input.ready)return result('idle','Запуск синхронизации','Плагин подготавливает хранилище.');
 if(input.kind==='active')return result('active','Идёт синхронизация','Выполняется обмен изменениями с облаком.');
 if(input.automaticOff)return result('idle','Автообмен выключен','Автоматическая синхронизация выключена в настройках.');
 if(input.kind==='ready')return result('ready','Подключено','Есть подключение для синхронизации. Это не подтверждение передачи всех файлов.');
 if(['NOT_CONNECTED','CLOSED'].includes(input.status))return result('offline','Нет связи','Соединение для синхронизации сейчас не установлено. Проверьте интернет и настройки ArcaLink.');
 return result('idle','Ожидание синхронизации','Синхронизация ожидает следующего обмена.');
}
