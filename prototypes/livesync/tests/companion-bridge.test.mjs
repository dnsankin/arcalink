import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256,safeCompanionPath,validProofRequest,verifyCloudFile,proofReplyMatches} from '../plugin/companion-proof.mjs';
const bytes=new TextEncoder().encode('hello');
const file={path:'Inbox/test.md',size:bytes.length,sha256:await sha256(bytes)};
const metadata={_id:'note',_rev:'1-a',type:'plain',size:5,children:['h:a','h:b'],eden:{}};
function fixture(overrides={}){
 const docs={note:{...metadata},'h:a':{type:'leaf',data:'hel'},'h:b':{type:'leaf',data:'lo'},...overrides};
 return {id:'note',get:async id=>docs[id],decode:async doc=>new TextEncoder().encode(doc.data.join(''))};
}
test('only complete remote bytes confirm a file',async()=>assert.equal(await verifyCloudFile(file,fixture()),true));
test('metadata without every chunk never confirms',async()=>assert.equal(await verifyCloudFile(file,fixture({'h:b':false})),false));
test('corrupt, deleted or conflicted chunks never confirm',async()=>{
 for(const extra of [{isCorrupted:true},{_deleted:true},{_conflicts:['2-b']},{data:'wrong'}])assert.equal(await verifyCloudFile(file,fixture({'h:b':{type:'leaf',data:'lo',...extra}})),false);
});
test('conflicted/deleted/size-mismatched metadata never confirms',async()=>{
 for(const extra of [{_deleted:true},{deleted:true},{_conflicts:['2-b']},{size:8}])assert.equal(await verifyCloudFile(file,fixture({note:{...metadata,...extra}})),false);
});
test('a newer winning revision during readback invalidates proof',async()=>{
 const env=fixture();let reads=0;const get=env.get;env.get=async id=>id==='note'&&++reads>1?{...metadata,_rev:'2-b'}:get(id);
 assert.equal(await verifyCloudFile(file,env),false);
});
test('configuration/epoch change during await invalidates proof',async()=>{
 let current=true;const env=fixture();const get=env.get;env.get=async id=>{if(id==='h:b')current=false;return get(id);};
 assert.equal(await verifyCloudFile(file,{...env,stillCurrent:()=>current}),false);
});
test('embedded eden chunks are part of the remote revision proof',async()=>{
 const env=fixture({note:{...metadata,eden:{'h:a':{data:'hel'},'h:b':{data:'lo'}}},'h:a':false,'h:b':false});
 assert.equal(await verifyCloudFile(file,env),true);
});
test('same size is not sufficient evidence',async()=>assert.equal(await verifyCloudFile({...file,sha256:await sha256(new TextEncoder().encode('other'))},fixture()),false));
test('paths cannot expose config or escape the vault',()=>{
 for(const path of ['.obsidian/data.json','../a','/a','a//b','a/../b','a\\b','a\0b','a/.hidden','C:/file'])assert.equal(safeCompanionPath(path),false);
 assert.equal(safeCompanionPath('Покупки/Сегодня.md'),true);
});
test('bounded schema and exact nonce are mandatory',()=>{
 const input={schema:1,vaultId:'abcdefghijklmnop',requests:[{id:'abcdefghijklmnop',files:[file]}]};
 assert.equal(validProofRequest(input),true);assert.equal(validProofRequest({...input,schema:2}),false);
 assert.equal(validProofRequest({...input,requests:Array(51).fill(input.requests[0])}),false);
 const reply={schema:1,nonce:'request',...file,applied:true};assert.equal(proofReplyMatches(reply,file,'request'),true);
 assert.equal(proofReplyMatches(reply,file,'other'),false);assert.equal(proofReplyMatches({...reply,applied:false},file,'request'),false);
});
