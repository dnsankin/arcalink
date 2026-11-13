// Presentation only: no replication, readiness checks, requests or retries.
export function mobileSyncState(input={}) {
 const result=(kind,label,detail)=>({kind,label,detail,free:!!input.free,maintenance:null,
  counters:!input.free&&!!input.configured&&Number.isFinite(input.sent)&&input.sent>=0&&Number.isFinite(input.arrived)&&input.arrived>=0
   ?{sent:Math.floor(input.sent),arrived:Math.floor(input.arrived)}:null});
 if(input.companion){
  if(input.errors?.length)return result('error','Подключение требует внимания','Откройте состояние подключения Компаньона. Локальные файлы сохранены.');
  if(input.companion==='committed')return result('ready','Синхронизирует Компаньон','Передачу обычных файлов выполняет Компаньон. Подтверждение отправки смотрите в нём.');
  return result('idle','Подключаем Компаньон','Оставьте Obsidian открытым до завершения первой подготовки.');
 }
 if(input.maintenance){
  const stage={policy:'Проверяем общие исключения папок',inventory:'Читаем исходную локальную базу',
   copy:'Копируем записи локальной базы',source:'Сверяем исходную локальную базу',
   target:'Сверяем подготовленную локальную базу',finish:'Завершаем проверку локальной базы'}[input.maintenance.phase];
  if(stage){
   return {kind:'active',label:stage,detail:'Синхронизация начнётся после применения общих исключений. Android может приостановить проверку, пока Obsidian свёрнут.',
    counters:null,maintenance:input.maintenance};
  }
 }
 if(input.maintenanceFailed)return {kind:'error',label:'Не удалось применить общие исключения',
  detail:'Откройте настройки синхронизации, чтобы проверить подключение и состояние общих исключений.',counters:null,maintenance:null};
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
