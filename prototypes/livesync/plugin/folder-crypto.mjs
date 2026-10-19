import {decrypt,isPathProbablyObfuscated} from 'octagonal-wheels/encryption/encryption';
import {decrypt as decryptHKDF} from 'octagonal-wheels/encryption/hkdf';
const failure=()=>Object.assign(Error('folder-metadata-unreadable'),{code:'folder-metadata-unreadable'});

/** Decode only the engine metadata fields needed by the cleanup graph. */
export async function decodeFolderMetadata(doc,settings,parameters){
  if(!['plain','newnote'].includes(doc.type)||doc._deleted||!settings.encrypt)return doc;
  const legacy=async data=>{
    try{return await decrypt(data,settings.passphrase,!!settings.useDynamicIterationCount);}
    catch{try{return await decrypt(data,settings.passphrase,!settings.useDynamicIterationCount);}catch{throw failure();}}
  };
  const hkdf=async data=>{
    if(typeof parameters?.pbkdf2salt!=='string'||!parameters.pbkdf2salt)throw failure();
    const salt=Uint8Array.from(atob(parameters.pbkdf2salt),c=>c.charCodeAt(0));
    return decryptHKDF(data,settings.passphrase,salt);
  };
  const result={...doc};
  try{
    if(typeof result.path==='string'&&result.path.startsWith('/\\:'))Object.assign(result,JSON.parse(await hkdf(result.path.slice(3))));
    else if(result._id.startsWith('f:')&&isPathProbablyObfuscated(result.path))result.path=await legacy(result.path);
    if(doc.eden){
      const eden={...doc.eden};
      for(const [key,decode] of [['h:++encrypted',legacy],['h:++encrypted-hkdf',hkdf]]){
        if(eden[key]){const decoded=JSON.parse(await decode(eden[key].data));delete eden[key];for(const embedded of Object.keys(decoded))eden[embedded]={};}
      }
      result.eden=eden;
    }
    return result;
  }catch{throw failure();}
}
