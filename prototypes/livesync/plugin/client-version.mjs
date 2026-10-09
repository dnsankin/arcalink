import {responseError} from './pilot-http.mjs';

export function accountClientVersion(manifest) {
 if(manifest?.id!=='arcalink-sync')return manifest?.version;
 return /^\d+\.\d+\.\d+$/.test(manifest.version||'')?'arcalink-sync/'+manifest.version:undefined;
}

/** Update only the existing authenticated device's version, without a new login. */
export async function announceClientVersion(request,manifest,session) {
 if(manifest?.id!=='arcalink-sync'||!accountClientVersion(manifest)||!session?.accessToken||!session?.deviceId)return false;
 const response=await request({url:'https://arcalink.ru/devices/'+encodeURIComponent(session.deviceId)+'/heartbeat',method:'PATCH',headers:{Authorization:'Bearer '+session.accessToken,'Content-Type':'application/json'},body:JSON.stringify({app_version:accountClientVersion(manifest)}),throw:false});
 if(response.status!==200)throw Error(responseError(response));
 return true;
}
