import {initializePeerLedger} from './companion-action-peer-ledger.mjs';
import {initializeActionGrantRegistry} from './companion-peer-action-grants.mjs';
import {initializeActionStaging} from './companion-peer-action-staging.mjs';
import {initializePeerActionResults} from './companion-peer-action-results.mjs';
const fail=code=>Object.assign(Error(code),{code});
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
/** Anchor lives in app-private storage; saveIfAbsent must be atomic across owners. */
export async function openPeerActionPrivateDb({database,anchor,account,workspace,initialize=false,atomicOpen}){
 if(!database||typeof database.createPouchDBInstance!=='function'||typeof anchor?.load!=='function'||initialize&&typeof anchor?.saveIfAbsent!=='function'||!token(account)||!token(workspace))throw fail('action-private-db-invalid');
 const main=database.localDatabase?.localDatabase;if(!main||typeof main.id!=='function')throw fail('action-private-db-unavailable');
 let saved=structuredClone(await anchor.load()),created=false;
 if(!saved){if(!initialize)throw fail('action-private-db-missing');created=true;saved={schema:atomicOpen?2:1,account,workspace,receiverId:crypto.randomUUID(),ledgerEpoch:crypto.randomUUID(),name:'arcalink-peer-actions-'+crypto.randomUUID(),mainId:await main.id(),...(atomicOpen?{storageId:crypto.randomUUID(),storageName:'arcalink-action-ingress-'+crypto.randomUUID()}: {})};}
 if(!saved||![1,2].includes(saved.schema)||Object.keys(saved).some(key=>!['schema','account','workspace','receiverId','ledgerEpoch','name','mainId','privateId',...(saved.schema===2?['storageId','storageName']:[])].includes(key))||saved.schema===2&&(!token(saved.storageId)||typeof saved.storageName!=='string'||!/^arcalink-action-ingress-[a-f0-9-]{36}$/.test(saved.storageName)||typeof atomicOpen!=='function')||saved.account!==account||saved.workspace!==workspace||!token(saved.receiverId)||!token(saved.ledgerEpoch)||typeof saved.name!=='string'||!/^arcalink-peer-actions-[a-f0-9-]{36}$/.test(saved.name)||typeof saved.mainId!=='string'||!saved.mainId||saved.mainId!==await main.id()||!created&&(typeof saved.privateId!=='string'||!saved.privateId))throw fail('action-private-db-invalid');
 const db=database.createPouchDBInstance(saved.name,{auto_compaction:false});let atomic;
 try{
  const privateId=await db.id();if(typeof privateId!=='string'||!privateId||privateId===saved.mainId||!created&&privateId!==saved.privateId)throw fail('action-private-db-changed');
  if(saved.schema===2)atomic=await atomicOpen({name:saved.storageName,storageId:saved.storageId,scope:{account,workspace,receiverId:saved.receiverId,ledgerEpoch:saved.ledgerEpoch,privateId},initialize:created});
  if(created){
   const scope={db,account,workspace,receiverId:saved.receiverId,ledgerEpoch:saved.ledgerEpoch};
   await initializePeerLedger(scope);await initializeActionGrantRegistry(scope);await initializeActionStaging(db,{account,workspace,receiverId:saved.receiverId,ledgerEpoch:saved.ledgerEpoch,grantId:'initial000'});await initializePeerActionResults(db,{account,workspace,receiverId:saved.receiverId,ledgerEpoch:saved.ledgerEpoch});
   saved={...saved,privateId};if(await anchor.saveIfAbsent(structuredClone(saved))!==true){await atomic?.close();await db.close();return openPeerActionPrivateDb({database,anchor,account,workspace,atomicOpen});}
   if(JSON.stringify(await anchor.load())!==JSON.stringify(saved))throw fail('action-private-db-unverified');
  }
  if(database.localDatabase?.localDatabase!==main||await main.id()!==saved.mainId)throw fail('action-private-db-changed');
  return {db,atomic,binding:{account,workspace,receiverId:saved.receiverId,ledgerEpoch:saved.ledgerEpoch},current:async()=>(!atomic||atomic.current())&&database.localDatabase?.localDatabase===main&&await main.id()===saved.mainId&&await db.id()===saved.privateId&&JSON.stringify(await anchor.load())===JSON.stringify(saved)&&database.localDatabase?.localDatabase===main,close:async()=>{try{await atomic?.close();}finally{await db.close();}}};
 }catch(error){await atomic?.close().catch(()=>{});await db.close().catch(()=>{});throw error;}
}
