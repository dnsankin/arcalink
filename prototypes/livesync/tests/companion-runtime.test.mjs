import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import {sha256} from '../plugin/companion-proof.mjs';
const root=new URL('../',import.meta.url);
const esbuild=await import(new URL('.cache/source/node_modules/esbuild/lib/main.js',root));
const utils=new URL('.cache/source/node_modules/@vrtmrz/livesync-commonlib/dist/common/utils.js',root).href;
const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('plugin/companion-bridge.ts',root))],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'runtime-utils',setup(build){build.onResolve({filter:/^@vrtmrz\/livesync-commonlib\/compat\/common\/utils$/},()=>({path:utils,external:true}));}}]});
const {CompanionBridge}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
globalThis.window={setTimeout,clearTimeout};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
const bytes=new TextEncoder().encode('hello').buffer;
const file={path:'note.md',size:5,sha256:await sha256(bytes)};
function environment({free=false,requests=[{id:'request-abcdefghijkl',files:[file]}],mailbox=true}={}){
 const settings={isConfigured:true,remoteType:free?'ONLY_P2P':'',P2P_relays:'wss://arcalink.ru/sync-lab/free/signal',P2P_roomID:'room',couchDB_URI:'https://example.invalid',couchDB_DBNAME:'db'};
 const docs={'note.md':{_id:'note.md',_rev:'1-a',type:'plain',size:5,children:['h:chunk']},'h:chunk':{type:'leaf',data:'hello'}};
 const hooks=[],writes=[];let closed=0;
 const engine={connectRemoteCouchDBWithSetting:async(s,m,setup,info,options)=>({db:{get:async id=>docs[id]},close:async()=>{closed++;}})};
 const replicator={onBeforeReplicatorPublication:{addHandler:callback=>hooks.push(callback)},runWithActiveReplicatorContext:async callback=>callback({replicator:engine})};
 const plugin={pilotDirectory:'.obsidian/plugins/arcalink-sync',folders:{contains:()=>false},core:{services:{replicator,setting:{currentSettings:()=>settings},appLifecycle:{isSuspended:()=>false},path:{path2id:async path=>path},vault:{isTargetFile:async()=>true}}},app:{isMobile:true,vault:{getAbstractFileByPath:path=>({path,extension:'md',stat:{size:path==='large.bin'?67108865:5}}),readBinary:async()=>bytes,adapter:{exists:async()=>mailbox,read:async()=>JSON.stringify({schema:1,vaultId:'vault-abcdefghijkl',requests}),write:async(path,text)=>writes.push(JSON.parse(text))}}}};
 return {plugin,engine,settings,docs,hooks,writes,get closed(){return closed;}};
}
test('runtime bridge owns remote connection and emits exact-version cloud receipt',async()=>{
 const e=environment(),bridge=new CompanionBridge(e.plugin);await bridge.tick();assert.equal(e.closed,1);assert.equal(e.writes.at(-1).results[0].state,'confirmed');assert.equal(e.writes.at(-1).results[0].scope,'cloud');bridge.dispose();
});
test('publication replacement with identical settings invalidates the runtime pass',async()=>{
 const e=environment();let read=0;e.engine.connectRemoteCouchDBWithSetting=async()=>({db:{get:async id=>{if(++read===2)for(const hook of e.hooks)await hook();return e.docs[id];}},close:async()=>{}});
 const bridge=new CompanionBridge(e.plugin);await bridge.tick();assert.equal(e.writes.length,0);bridge.dispose();
});
test('a large unsupported request does not poison an unrelated note receipt',async()=>{
 const e=environment({requests:[{id:'large-abcdefghijkl',files:[{...file,path:'large.bin',size:67108865}]},{id:'small-abcdefghijkl',files:[file]}]});
 const bridge=new CompanionBridge(e.plugin);await bridge.tick();assert.deepEqual(e.writes.at(-1).results.map(r=>r.state),['unsupported','confirmed']);bridge.dispose();
});
test('Free proof uses existing admitted peer RPC with cancellation signal and vault readback',async()=>{
 const receiver=environment({free:true,mailbox:false}),sender=environment({free:true});let signal;
 function host(){return {isDisposed:false,isServing:true,assignedFunctions:new Map(),knownAdvertisements:[{peerId:'phone'}],evaluatePeerAcceptance:async()=> 'accepted',serveFunction(name,handler){this.assignedFunctions.set(name,handler);}};}
 const remote=host(),local=host();local.getConnection=()=>({invokeRemoteFunction:async(name,args,timeout,abort)=>{signal=abort;return remote.assignedFunctions.get(name)('sender',...args);}});
 receiver.plugin.arcalinkP2P={replicator:{rawHost:remote}};sender.plugin.arcalinkP2P={replicator:{rawHost:local}};
 const receiving=new CompanionBridge(receiver.plugin),sending=new CompanionBridge(sender.plugin);await receiving.tick();await sending.tick();
 assert.ok(signal instanceof AbortSignal);assert.equal(sender.writes.at(-1).results[0].scope,'peer-vault');
 const readback=remote.assignedFunctions.get('arcalinkCompanionReadbackV1');const privateReply=await readback('sender',{schema:1,nonce:'abcdefghijklmnop',file:{...file,path:'.obsidian/credentials.json'}});assert.equal(privateReply.applied,false);
 receiving.dispose();sending.dispose();
});
test('disposed bridge neither reads nor publishes',async()=>{
 const e=environment(),bridge=new CompanionBridge(e.plugin);bridge.dispose();await bridge.tick();assert.equal(e.closed,0);assert.equal(e.writes.length,0);
});

test('unchanged confirmed media is not downloaded on every heartbeat; manual refresh verifies again',async()=>{
 const e=environment(),bridge=new CompanionBridge(e.plugin);await bridge.tick();const time=e.writes.at(-1).results[0].verifiedAt;
 await bridge.tick();assert.equal(e.closed,1);assert.equal(e.writes.at(-1).results[0].verifiedAt,time);
 e.plugin.app.vault.adapter.read=async()=>JSON.stringify({schema:1,vaultId:'vault-abcdefghijkl',refreshNonce:'manual-refresh-abcdefgh',requests:[{id:'request-abcdefghijkl',files:[file]}]});
 await bridge.tick();assert.equal(e.closed,2);assert.equal(e.writes.at(-1).refreshNonce,'manual-refresh-abcdefgh');bridge.dispose();
});
