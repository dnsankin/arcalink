import test from 'node:test';
import assert from 'node:assert/strict';
import {createShared2StartupCheckpoint} from '../plugin/shared2-startup-checkpoint.mjs';

test('old ancestry, a changed file, a conflict or a failed comparison cannot suppress startup work',async()=>{
 const file={path:'Owner/Shared/attachment.pdf',_rev:'1-base',size:12};
 let record={revision:'1-base'},current={type:'file',size:12,mtime:10,ctime:10},digest='local',changeDuringRead=false;
 const proof=createShared2StartupCheckpoint({documentRoot:'Owner/Shared',
  provenance:{get:async()=>record,verify:async(_path,revision,verifiedStat)=>{record={revision,verifiedStat};}},
  metadata:async()=>file,stat:async()=>({...current}),fingerprint:async()=>{if(changeDuringRead)current.ctime++;return digest;},
  revisionProof:async()=>({size:12,sha256:'database'})});
 assert.equal(await proof.isVerified(file),false);
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),false);
 digest='database';changeDuringRead=true;
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),false);
 changeDuringRead=false;
 await proof.remember(file);
 assert.equal(await proof.isVerified(file),true);
 assert.equal(await proof.isVerified({...file,_conflicts:['2-other']}),false);
 assert.equal(await proof.isVerified({...file,_rev:'2-new'}),false);
 assert.equal(await proof.isVerified({...file,deleted:true}),false);
 assert.equal(await proof.isVerified({...file,path:'Owner/Other/attachment.pdf'}),false);
 current.ctime++;
 assert.equal(await proof.isVerified(file),false,'even a same-size file with its original mtime needs a check when ctime changed');
});
