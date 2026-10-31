import {getConfiguredFunctionsForEncryption} from '@arcalink/shared2-engine-encryption';
import {E2EEAlgorithms} from '@vrtmrz/livesync-commonlib/compat/common/types';
const fail=code=>Object.assign(Error(code),{code});
/** Read-only compatibility with an EXISTING personal cipher. Arbitrary personal
 * passphrases are not shared2 keys and are never persisted or sent to the server.
 * The salt callback must only READ the frozen source's existing parameters;
 * unlike the ordinary sync-parameter manager it must never create a missing salt.
 */
export function createShared2PrivateDecryptor(settings,{getSalt,isCurrent=async()=>true}){
 if(settings?.encrypt!==true||typeof settings.passphrase!=='string'||!settings.passphrase||typeof getSalt!=='function')throw fail('shared2-private-cipher-settings-required');
 const algorithm=settings.E2EEAlgorithm??E2EEAlgorithms.V1;
 if(!Object.values(E2EEAlgorithms).includes(algorithm))throw fail('shared2-private-cipher-unsupported');
 const passphrase=settings.passphrase,dynamic=settings.useDynamicIterationCount===true;let salt;
 async function current(){if(!await isCurrent())throw fail('shared2-private-cipher-scope-changed');}
 async function existingSalt(){await current();if(!salt){const value=await getSalt();if(!(value instanceof Uint8Array)||value.length!==32)throw fail('shared2-private-source-salt-missing');salt=value.slice();}return salt.slice();}
 const transforms=getConfiguredFunctionsForEncryption(passphrase,dynamic,false,existingSalt,algorithm,true),decrypted=new WeakSet();
 return async doc=>{await current();if(decrypted.has(doc))return doc;let result;try{result=await transforms.outgoing(doc);}catch(error){if(error.code==='shared2-private-source-salt-missing'||error.code==='shared2-private-cipher-scope-changed')throw error;throw fail('shared2-private-source-decryption-rejected');}await current();decrypted.add(result);return result;};
}
export async function readShared2PrivateSalt(database){
 let parameters;try{parameters=await database.get('_local/obsidian_livesync_sync_parameters');}catch(error){if(error.status===404)throw fail('shared2-private-source-salt-missing');throw error;}
 const value=parameters?.pbkdf2salt;if(typeof value!=='string'||!(/^[A-Za-z0-9+/]{43}=$/).test(value))throw fail('shared2-private-source-salt-missing');
 let bytes;try{bytes=Uint8Array.from(atob(value),character=>character.charCodeAt(0));}catch{throw fail('shared2-private-source-salt-missing');}if(bytes.length!==32)throw fail('shared2-private-source-salt-missing');return bytes;
}
export function configureShared2PrivateSource(database,settings,options={}){
 if(typeof database?.transform!=='function')throw fail('shared2-private-cipher-adapter-required');
 const outgoing=createShared2PrivateDecryptor(settings,{...options,getSalt:options.getSalt||(()=>readShared2PrivateSalt(database))});
 database.transform({outgoing});
 // Fail before the Pouch wrapper delegates a mutation or starts a network call.
 // The job gateway independently enforces the same read-only grant.
 for(const method of ['put','post','bulkDocs','remove','putAttachment','removeAttachment','compact','destroy'])database[method]=(...args)=>{const error=fail('shared2-private-source-read-only'),rejected=Promise.reject(error),callback=args[args.length-1];if(typeof callback==='function')rejected.catch(error=>callback(error));return rejected;};
}

/** Quarantined P1 encoder for reverse migration. Same existing personal cipher,
 * original salt and arbitrary passphrase; no rekey of outside private records.
 * The server's job-scoped admission/physical quarantine remain mandatory.
 */
export function createShared2PrivateEncryptor(settings,{getSalt,isCurrent=async()=>true}){
 if(settings?.encrypt!==true||typeof settings.passphrase!=='string'||!settings.passphrase||typeof getSalt!=='function')throw fail('shared2-private-cipher-settings-required');
 const algorithm=settings.E2EEAlgorithm??E2EEAlgorithms.V1;if(!Object.values(E2EEAlgorithms).includes(algorithm))throw fail('shared2-private-cipher-unsupported');
 const passphrase=settings.passphrase,dynamic=settings.useDynamicIterationCount===true,requireObfuscation=settings.usePathObfuscation===true;let salt;
 async function current(){if(!await isCurrent())throw fail('shared2-private-cipher-scope-changed');}
 async function existingSalt(){await current();if(!salt){const value=await getSalt();if(!(value instanceof Uint8Array)||value.length!==32)throw fail('shared2-private-source-salt-missing');salt=value.slice();}return salt.slice();}
 const transforms=getConfiguredFunctionsForEncryption(passphrase,dynamic,false,existingSalt,algorithm,true);
 return async doc=>{await current();if(!doc||typeof doc._id!=='string'||!doc._id||doc._id.startsWith('_'))throw fail('shared2-private-target-document');const result=await transforms.incoming(doc);if(!doc._deleted&&doc.type==='leaf'&&result.e_!==true)throw fail('shared2-private-target-plaintext-rejected');if(!doc._deleted&&['plain','newnote'].includes(doc.type)&&typeof doc.path==='string'){const obfuscated=doc._id.startsWith('f:');if(requireObfuscation&&!obfuscated)throw fail('shared2-private-target-obfuscation-scope');if(obfuscated&&result.path===doc.path)throw fail('shared2-private-target-plaintext-rejected');}await current();return result;};
}
export function configureShared2PrivateTarget(database,settings,options={}){
 if(typeof database?.transform!=='function')throw fail('shared2-private-cipher-adapter-required');
 const getSalt=options.getSalt||(()=>readShared2PrivateSalt(database));
 database.transform({incoming:createShared2PrivateEncryptor(settings,{...options,getSalt}),outgoing:createShared2PrivateDecryptor(settings,{...options,getSalt})});
 // PouchDB deliberately bypasses transforms for _local documents. Guard every
 // mutation entry point as well, before it can issue a parameter/checkpoint PUT.
 const regular=id=>typeof id==='string'&&id.length>0&&!id.startsWith('_');
 for(const method of ['put','remove','bulkDocs']){const original=database[method];if(typeof original!=='function')continue;database[method]=function(...args){
  const docs=method==='bulkDocs'?(Array.isArray(args[0])?args[0]:args[0]?.docs):[args[0]],ids=docs?.map(doc=>method==='remove'&&typeof doc==='string'?doc:doc?._id);
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!regular(id)))return Promise.reject(fail('shared2-private-target-document'));
  return original.apply(this,args);
 };}
 for(const method of ['post','putAttachment','removeAttachment','destroy','compact','viewCleanup'])if(typeof database[method]==='function')database[method]=()=>Promise.reject(fail('shared2-private-target-document'));
}
