import {safeRelative} from './folder-model.mjs';
const fail=()=>Object.assign(Error('shared2-invalid-server-catalog'),{code:'shared2-invalid-server-catalog'});
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value),number=value=>Number.isSafeInteger(value)&&value>=0;
export function checkedShared2ServerCatalog(value){
 if(!value||value.protocol!==2||!identity(value.account)||!number(value.revision)||!Array.isArray(value.folders)||value.folders.length>1000)throw fail();
 const seen=new Set();
 for(const row of value.folders){
  if(!row||typeof row.id!=='string'||!/^[a-f0-9]{32}$/.test(row.id)||seen.has(row.id)||!identity(row.owner)||!identity(row.ownerWorkspace)||!safeRelative(row.documentRoot)||typeof row.database!=='string'||!/^arcalink_(?:s|p|legacy)_[a-f0-9]{32}$/.test(row.database)||!number(row.generation)||row.generation<1||!number(row.revision)||!number(row.authorityEpoch)||row.authorityEpoch<1||!number(row.membershipEpoch)||row.membershipEpoch<1||!['owner','editor','viewer'].includes(row.role)||typeof row.encrypted!=='boolean'||!number(row.keyEpoch)||(row.encrypted?row.keyEpoch<1:row.keyEpoch!==0)||row.ownerLabel!==undefined&&(typeof row.ownerLabel!=='string'||row.ownerLabel.length>320))throw fail();
  seen.add(row.id);
 }
 return structuredClone(value);
}
/** Membership survives offline gaps. A missed revoke/reaccept must require an
 * explicit reconnect; an authority cycle needs a fresh cache even if role matches. */
export function shared2AuthorityTransition(record,row){
 if(record.protocol!==2)return 'initial';
 if(record.shared2MembershipEpoch!==undefined&&record.shared2MembershipEpoch!==row.membershipEpoch)return 'reaccepted';
 if(record.role!==row.role||record.shared2AuthorityEpoch!==row.authorityEpoch||record.shared2Generation!==undefined&&record.shared2Generation!==row.generation||record.shared2Database!==undefined&&record.shared2Database!==row.database||record.shared2KeyEpoch!==undefined&&record.shared2KeyEpoch!==row.keyEpoch)return 'baseline';
 return 'unchanged';
}
