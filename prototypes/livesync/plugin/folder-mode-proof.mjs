import {decrypt} from 'octagonal-wheels/encryption/encryption';
import {decrypt as decryptHKDF} from 'octagonal-wheels/encryption/hkdf';

export const modeProofMessages={
 'workspace-encryption-unknown':'Не удалось подтвердить режим шифрования хранилища. Общее исключение не применено. Локальные файлы сохранены.',
 'workspace-encryption-mixed':'В облачном хранилище обнаружены данные с разными режимами шифрования. Общее исключение не применено. Обратитесь в поддержку.',
 'workspace-encryption-unreadable':'Не удалось проверить формат облачных данных. Общее исключение не применено. Обратитесь в поддержку.',
 'workspace-encryption-changed':'Во время проверки хранилище изменилось. Повторите изменение общих исключений после завершения синхронизации.',
 'workspace-encryption-proof-invalid':'Проверка хранилища устарела. Повторите изменение общих исключений.',
 'workspace-encryption-mismatch':'Режим шифрования не совпадает с настройками хранилища. Проверьте подключение и парольную фразу.',
 'workspace-encryption-key-invalid':'Парольная фраза не подходит к облачным данным. Общее исключение не применено. Проверьте парольную фразу.'
};
const fail=code=>Object.assign(Error(modeProofMessages[code]),{code});

/** Check ciphertext locally. Never return plaintext or send a key to the API. */
export async function verifyModeProofPage(page,settings){
 if(!page||!Array.isArray(page.witnesses)||page.witnesses.length>8||![null,false,true].includes(page.encrypted)
   ||!(page.cursor===null&&typeof page.proof==='string'||typeof page.cursor==='string'&&page.proof===null))throw fail('workspace-encryption-unreadable');
 if(page.encrypted!==null&&page.encrypted!==!!settings.encrypt)throw fail('workspace-encryption-mismatch');
 if(page.witnesses.length&&!settings.encrypt)throw fail('workspace-encryption-mismatch');
 for(const witness of page.witnesses){
  if(!witness||!['data','path','metadata','eden'].includes(witness.kind)||typeof witness.data!=='string'||!witness.data.startsWith('%')||witness.data.length>1024*1024)throw fail('workspace-encryption-unreadable');
  try{
   let text;
   if(witness.data.startsWith('%=')){
    const value=page.parameters?.pbkdf2salt;
    if(typeof value!=='string'||!value||value.length>2048)throw Error();
    const salt=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
    text=await decryptHKDF(witness.data,settings.passphrase,salt);
   }else{
    try{text=await decrypt(witness.data,settings.passphrase,!!settings.useDynamicIterationCount);}
    catch{text=await decrypt(witness.data,settings.passphrase,!settings.useDynamicIterationCount);}
   }
   if(typeof text!=='string')throw Error();
   if(witness.kind==='metadata'||witness.kind==='eden'){
    const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
    if(witness.kind==='metadata'&&typeof value.path!=='string')throw Error();
   }
   if(witness.kind==='path'&&!text)throw Error();
  }catch{throw fail('workspace-encryption-key-invalid');}
 }
 return page.witnesses.length;
}
