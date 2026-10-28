import {sha256} from './companion-proof.mjs';
export const ASSISTANT_SITE='https://arcalink.ru/android';
export const ASSISTANT_CATALOG='https://arcalink.ru/downloads/android/latest.json';
export function validateAssistantRelease(value){
 if(!value||value.schema!==1||value.package!=='ru.arcalink.companion'||!/^\d+\.\d+\.\d+$/.test(value.version)||
  !Number.isSafeInteger(value.versionCode)||value.versionCode<1||!Number.isSafeInteger(value.size)||value.size<=0||value.size>64*1024*1024||
  !/^[a-f0-9]{64}$/.test(value.sha256)||!/^[a-f0-9]{64}$/.test(value.signingCertificateSha256)||
  value.filename!==`ArcaLink-Android-${value.version}.apk`||value.url!==`https://arcalink.ru/downloads/android/${value.filename}`||
  !Number.isFinite(Date.parse(value.releasedAt))||Date.parse(value.releasedAt)>Date.now()+300000||typeof value.changes!=='string'||value.changes.length>8000)
  throw Error('Сведения о выпуске Android-помощника не прошли проверку.');
 return value;
}
/** @param {string} url @param {number} limit @param {{signal?:AbortSignal,fetcher?:typeof fetch}} options */
export async function boundedOfficialGet(url,limit,{signal,fetcher=fetch}={}){
 const parsed=new URL(url);
 if(parsed.origin!=='https://arcalink.ru'||!parsed.pathname.startsWith('/downloads/android/')||parsed.search||parsed.hash)throw Error('Неофициальный источник Android-помощника.');
 const response=await fetcher(url,{redirect:'error',credentials:'omit',cache:'no-store',signal});
 if(!response.ok||response.redirected||(response.url&&new URL(response.url).origin!==parsed.origin))throw Error('Официальный выпуск пока недоступен. Повторите позже.');
 const length=Number(response.headers.get('Content-Length'));if(length>limit)throw Error('Установщик превышает допустимый размер.');
 const reader=response.body?.getReader();
 if(!reader){const bytes=await response.arrayBuffer();if(bytes.byteLength>limit)throw Error('Установщик слишком большой.');return bytes;}
 const parts=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit)throw Error('Установщик слишком большой.');parts.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes.buffer;
}
export async function verifyAssistantApk(release,bytes){
 validateAssistantRelease(release);
 if(bytes.byteLength!==release.size||await sha256(bytes)!==release.sha256)throw Error('Установщик не прошёл проверку целостности. Файл не передан в обменник.');
 return true;
}
