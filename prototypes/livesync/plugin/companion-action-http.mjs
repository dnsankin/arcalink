/** Only machine codes are retained; HTML/proxy diagnostics never become user-visible secrets. */
export function actionHttpError(status,body){
 const candidate=body?.error_code??body?.error;
 const code=typeof candidate==='string'&&/^[a-z][a-z0-9-]{0,95}$/.test(candidate)?candidate:'';
 if(code==='companion-actions-unavailable')return 'action-service-unavailable';
 if(code)return code;
 if(status===401)return 'action-auth-required';
 if(status===403)return 'action-access-denied';
 if(status===404)return 'action-service-not-found';
 if(status===413)return 'action-request-too-large';
 if(status===429)return 'action-rate-limited';
 return 'action-service-unavailable';
}
export function actionDeliveryMessage(code){
 switch(code){
  case 'action-service-not-found':return 'Сервис самостоятельной отправки пока недоступен на сервере. Файл сохранён в очереди; доставка не подтверждена.';
  case 'action-service-unavailable':return 'Сервис отправки временно недоступен. Файл сохранён в очереди; попытка будет повторена.';
  case 'action-auth-required':case 'action-access-denied':return 'Сервер не подтвердил доступ для отправки. Проверьте подключение аккаунта; файл сохранён в очереди.';
  case 'action-rate-limited':return 'Сервер ограничил частоту запросов. Файл сохранён в очереди; попытка будет повторена.';
  case 'action-request-too-large':return 'Сервер отклонил размер запроса. Файл сохранён на устройстве; доставка не подтверждена.';
  default:return 'Отправка не подтверждена. Файл сохранён в очереди. Код: '+code;
 }
}
