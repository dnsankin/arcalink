import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const esbuild=await import(new URL('.cache/source/node_modules/esbuild/lib/main.js',root));
const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('plugin/companion-sync.ts',root))],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'authority',setup(build){build.onResolve({filter:/^@vrtmrz\/livesync-commonlib\/replication$/},()=>({path:'authority',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const NO_INTERACTION={kind:"none"};'}));}}]});
const {CompanionSync}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
const id='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222';
function environment(){
 const folder='.obsidian/plugins/arcalink-sync/companion/',memory=new Map(),calls=[];
 const request={schema:1,id,reason:'save',requestedAt:Date.now()};memory.set(folder+'sync-request.json',JSON.stringify(request));
 const settings={isConfigured:true,couchDB_DBNAME:'vault'},state={paused:false,ready:true};
 const plugin={pilotDirectory:folder.slice(0,-'/companion/'.length),workspaces:{busy:false},app:{vault:{adapter:{stat:async path=>memory.has(path)?{type:'file',size:memory.get(path).length}:null,read:async path=>memory.get(path),write:async(path,text)=>{memory.set(path,text);calls.push(['write',path,JSON.parse(text)]);}}}},core:{services:{setting:{currentSettings:()=>settings},appLifecycle:{isReady:()=>state.ready,isSuspended:()=>state.paused},vault:{scanVault:async(...args)=>calls.push(['scan',...args])},replication:{replicateUnattendedByEvent:async request=>{calls.push(['replicate',request]);return {status:'completed'};}}}}};
 return {plugin,settings,state,memory,calls,request,put(value){memory.set(folder+'sync-request.json',JSON.stringify(value));},get result(){return JSON.parse(memory.get(folder+'sync-result.json')||'null');}};
}
test('new local hint scans SAF changes then uses the ordinary unattended entrypoint without UI authority',async()=>{
 const e=environment(),sync=new CompanionSync(e.plugin);await sync.tick();
 assert.deepEqual(e.calls.map(c=>c[0]),['scan','write','replicate','write']);
 assert.deepEqual(e.calls[0],['scan',false,false,true]);
 assert.deepEqual(e.calls[2][1],{trigger:'database-event',interaction:{kind:'none'}});
 assert.equal(e.result.state,'completed');assert.equal(e.result.confirmed,undefined);assert.equal(e.result.files,undefined);
 await sync.tick();await new CompanionSync(e.plugin).tick();assert.equal(e.calls.filter(c=>c[0]==='replicate').length,1);
});
for(const blocked of ['paused','not-ready','offline','not-configured','workspace-switch'])test(`hint stays pending while ${blocked}`,async()=>{
 const e=environment();if(blocked==='paused')e.state.paused=true;if(blocked==='not-ready')e.state.ready=false;
 if(blocked==='not-configured')e.settings.isConfigured=false;if(blocked==='workspace-switch')e.plugin.workspaces.busy=true;
 if(blocked==='offline')navigator.onLine=false;
 try{await new CompanionSync(e.plugin).tick();assert.equal(e.calls.length,0);assert.equal(e.result,null);}
 finally{navigator.onLine=true;}
});
for(const invalid of [{id:'../../escape'}, {schema:2},{requestedAt:Date.now()-86400001},{requestedAt:Date.now()+60000},{reason:'launch'},{requestedAt:'now'}])test(`reject malformed hint ${JSON.stringify(invalid)}`,async()=>{
 const e=environment();e.put({...e.request,...invalid});await new CompanionSync(e.plugin).tick();assert.equal(e.calls.length,0);
});
test('oversized mailbox is not read',async()=>{
 const e=environment();e.plugin.app.vault.adapter.stat=async()=>({type:'file',size:4097});e.plugin.app.vault.adapter.read=async()=>assert.fail('must not read');
 await new CompanionSync(e.plugin).tick();assert.equal(e.calls.length,0);
});
for(const change of ['dispose','configuration','pause','new-request'])test(`scan completing after ${change} cannot kick stale work`,async()=>{
 const e=environment(),sync=new CompanionSync(e.plugin);
 e.plugin.core.services.vault.scanVault=async()=>{if(change==='dispose')sync.dispose();if(change==='configuration')e.settings.couchDB_DBNAME='other';if(change==='pause')e.state.paused=true;if(change==='new-request')e.put({...e.request,id:next});};
 await sync.tick();assert.equal(e.calls.filter(c=>c[0]==='replicate').length,0);assert.equal(e.result,null);
});
test('concurrent polls coalesce and a failed attempt is not retried by this bridge',async()=>{
 const e=environment();let release;const gate=new Promise(resolve=>release=resolve);
 e.plugin.core.services.vault.scanVault=async()=>{await gate;e.calls.push(['scan']);};
 e.plugin.core.services.replication.replicateUnattendedByEvent=async()=>{e.calls.push(['replicate']);throw Error('offline');};
 const sync=new CompanionSync(e.plugin),first=sync.tick();await sync.tick();release();await first;
 assert.equal(e.result.state,'failed');await new CompanionSync(e.plugin).tick();assert.equal(e.calls.filter(c=>c[0]==='replicate').length,1);
});
test('cannot invoke engine if persisting consumption fails',async()=>{
 const e=environment();e.plugin.app.vault.adapter.write=async()=>{throw Error('read only');};await new CompanionSync(e.plugin).tick();
 assert.equal(e.calls.filter(c=>c[0]==='replicate').length,0);
});
test('blocked provider outcome is preserved without claiming file delivery',async()=>{
 const e=environment();e.plugin.core.services.replication.replicateUnattendedByEvent=async()=>({status:'blocked',reason:'no-targets'});
 await new CompanionSync(e.plugin).tick();assert.equal(e.result.state,'blocked');assert.equal(e.result.confirmed,undefined);
});
