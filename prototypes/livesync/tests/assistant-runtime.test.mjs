import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {sha256} from '../plugin/companion-proof.mjs';
const root=new URL('../',import.meta.url),esbuild=await import(new URL('.cache/source/node_modules/esbuild/lib/main.js',root));
const uiStub=[
 'export class Modal { constructor(){this.titleEl={setText:text=>this.title=text};this.contentEl=globalThis.__assistantElement();} open(){globalThis.__assistantDialogs.push(this);this.onOpen();} close(){} }',
 'export class Notice {}',
 'export class Setting { constructor(){} addButton(callback){const button={setButtonText(text){this.text=text;return this;},setCta(){return this;},setDisabled(){return this;},onClick(click){this.click=click;return this;}};callback(button);return this;} setName(){return this;} setHeading(){return this;} addDropdown(callback){const dropdown={addOption(){return this;},setValue(){return this;},onChange(){return this;}};callback(dropdown);return this;} }',
 'export const Platform={get isAndroidApp(){return globalThis.__assistantAndroid===true;}};',
 'export const requestUrl=options=>globalThis.__assistantNetwork(options);'
].join('\n');
const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('plugin/mobile-assistant.ts',root))],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'obsidian-ui',setup(b){b.onResolve({filter:/^(obsidian|\.\/localized-obsidian)$/},()=>({path:'ui',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:uiStub}));}}]});
const {MobileAssistant}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
globalThis.window={setTimeout,clearTimeout};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
const bytes=new TextEncoder().encode('APK fixture').buffer;
const release={schema:1,package:'ru.arcalink.companion',version:'0.1.0',versionCode:1,size:bytes.byteLength,sha256:await sha256(bytes),signingCertificateSha256:'a'.repeat(64),filename:'ArcaLink-Android-0.1.0.apk',url:'https://arcalink.ru/downloads/android/ArcaLink-Android-0.1.0.apk',releasedAt:'2026-10-27T00:00:00Z',changes:'test'};
const workspace='a'.repeat(32),target={id:'phone',name:'Phone'};
function defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function environment(){
 globalThis.__assistantAndroid=false;globalThis.__assistantUi=[];globalThis.__assistantDialogs=[];
 globalThis.__assistantElement=(tag='root',options={})=>({tag,...options,children:[],isConnected:true,handlers:{},addEventListener(name,callback){this.handlers[name]=callback;},empty(){this.children=[];},createEl(childTag,childOptions){const child=globalThis.__assistantElement(childTag,childOptions);this.children.push(child);globalThis.__assistantUi.push(child);return child;}});
 const memory=new Map(),calls=[];let writes=0;
 const delivery={id:'b'.repeat(32),sender:'sender',target:'phone',path:'Exchange/ArcaLink Android/0.1.0/'+release.filename,state:'preparing',version:release.version};
 globalThis.fetch=async()=>new Response(bytes);
 globalThis.__assistantNetwork=async options=>{const action=options.url.split('/').at(-1),body=JSON.parse(options.body);calls.push({action,body});return {status:200,json:action==='create'?{delivery:{...delivery,path:body.path},existing:false}:{delivery:{...delivery,state:action==='cancel'?'cancelled':'waiting'}}};};
 const plugin={pilotDirectory:'.obsidian/plugins/arcalink-sync',unifiedVault:{base:'https://arcalink.ru/sync/api'},workspaces:{session:async()=>({deviceId:'sender'})},desktop:{settings:{exchangeFolder:'Exchange'}},folderPolicies:{bindingId:async()=>workspace,credentialsAuth:async()=>({auth:'Basic fixture'}),excludes:()=>false},folders:{contains:()=>false},core:{services:{vault:{isTargetFile:async()=>true,isFileSizeTooLarge:()=>false}}},app:{vault:{createBinary:async(path,data)=>{writes++;memory.set(path,data);},createFolder:async path=>memory.set(path,'folder'),adapter:{exists:async path=>memory.has(path),read:async path=>memory.get(path),write:async(path,data)=>memory.set(path,data),writeBinary:async(path,data)=>{writes++;memory.set(path,data);},readBinary:async path=>memory.get(path),rename:async(from,to)=>{memory.set(to,memory.get(from));memory.delete(from);},remove:async path=>memory.delete(path)}}}};
 return {assistant:new MobileAssistant(plugin),plugin,memory,calls,delivery,get writes(){return writes;}};
}
test('cancel while create is pending prevents subsequent APK download and commit',async()=>{
 const e=environment(),pending=defer(),started=defer(),network=globalThis.__assistantNetwork;let fetches=0;
 globalThis.fetch=async()=>{fetches++;return new Response(bytes);};
 globalThis.__assistantNetwork=options=>options.url.endsWith('/create')?(started.resolve(),pending.promise):network(options);
 const task=e.assistant.start(target,release,workspace);await started.promise;await e.assistant.cancel();pending.resolve({status:200,json:{delivery:e.delivery,existing:false}});await task;
 assert.equal(fetches,0);assert.equal(e.writes,0);assert.equal(e.assistant.state,'cancelled');assert.ok(e.calls.some(call=>call.action==='cancel'));e.assistant.dispose();
});
test('cancelled download is terminal and cannot be resumed into a file write',async()=>{
 const e=environment(),started=defer();globalThis.fetch=async(url,options)=>{started.resolve();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));};
 const task=e.assistant.start(target,release,workspace);await started.promise;await e.assistant.cancel();await task;await e.assistant.resume();
 assert.equal(e.writes,0);assert.equal(e.assistant.state,'cancelled');e.assistant.dispose();
});
test('cancellation API failure never reports confirmed cancellation',async()=>{
 const e=environment();e.assistant.last={workspace,release,delivery:e.delivery};globalThis.__assistantNetwork=async()=>({status:503,json:{message:'offline'}});await e.assistant.cancel();
 assert.match(e.assistant.message,/не удалось подтвердить отмену/);assert.notEqual(e.assistant.state,'cancelled');e.assistant.dispose();
});
test('an operation owned by another sender is not downloaded by this device',async()=>{
 const e=environment();globalThis.__assistantNetwork=async()=>({status:200,json:{delivery:{...e.delivery,sender:'another-desktop'},existing:true}});await e.assistant.start(target,release,workspace);
 assert.equal(e.writes,0);assert.match(e.assistant.message,/другом устройстве/);await e.assistant.resume();assert.equal(e.writes,0);assert.match(e.assistant.message,/другое устройство/);e.assistant.dispose();
});
test('verified APK is committed and delivery remains waiting until phone receipt',async()=>{
 const e=environment();await e.assistant.start(target,release,workspace);assert.ok(e.memory.has(e.delivery.path));assert.equal(e.assistant.state,'waiting');assert.ok(e.calls.some(call=>call.action==='ready'));e.assistant.dispose();
});

test('explicit resend creates a fresh versioned destination and vault create event',async()=>{
 const e=environment();e.memory.set(e.delivery.path,bytes);await e.assistant.start(target,release,workspace,true);
 const path=e.calls.find(call=>call.action==='create').body.path;assert.notEqual(path,e.delivery.path);assert.ok(path.includes('/Повтор-'));assert.ok(e.memory.has(path));e.assistant.dispose();
});

for(const android of [false,true])test(`${android?'Android':'desktop'} offers the shared exchange without selecting or querying recipients`,async()=>{
 const e=environment(),fetches=[];globalThis.__assistantAndroid=android;
 e.plugin.folderPolicies.credentialsAuth=async()=>{throw Error('Recipient API must not be called');};
 globalThis.fetch=async url=>{fetches.push(url);return new Response(JSON.stringify(release));};
 await e.assistant.prepare();
 assert.equal(globalThis.__assistantDialogs[0].title,'Добавить помощник в обменник');
 assert.deepEqual(fetches,['https://arcalink.ru/downloads/android/latest.json']);
 assert.equal(e.calls.length,0);assert.equal(e.writes,0);assert.equal(e.assistant.last,null);e.assistant.dispose();
});
test('the shared flow verifies bytes and creates an ordinary vault file without delivery API calls',async()=>{
 const e=environment();globalThis.__assistantAndroid=true;
 e.plugin.workspaces.session=async()=>{throw Error('No recipient session needed');};
 await e.assistant.start(null,release,workspace);
 const path='Exchange/ArcaLink Android/0.1.0/'+release.filename;
 assert.deepEqual(new Uint8Array(e.memory.get(path)),new Uint8Array(bytes));
 assert.equal(e.assistant.state,'exchange-ready');assert.equal(e.assistant.last.kind,'exchange');
 const installer=JSON.parse(e.memory.get(e.plugin.pilotDirectory+'/companion/installers.json')).installers[0];
 assert.equal(installer.path,path);assert.equal(installer.sha256,release.sha256);assert.equal(installer.size,release.size);
 assert.equal(e.assistant.last.delivery.target,undefined);assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('a matching APK is reused without another vault create event',async()=>{
 const e=environment(),path='Exchange/ArcaLink Android/0.1.0/'+release.filename;e.memory.set(path,bytes);
 await e.assistant.start(null,release,workspace);
 assert.equal(e.writes,0);assert.equal(e.assistant.state,'exchange-ready');assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('a different file at the exchange path is never overwritten',async()=>{
 const e=environment(),path='Exchange/ArcaLink Android/0.1.0/'+release.filename,original=new TextEncoder().encode('foreign APK').buffer;e.memory.set(path,original);
 await e.assistant.start(null,release,workspace);
 assert.equal(e.writes,0);assert.equal(e.memory.get(path),original);assert.equal(e.assistant.state,'error');assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('cancelling a shared download needs no target or server cancellation',async()=>{
 const e=environment(),started=defer();
 globalThis.fetch=async(url,options)=>{started.resolve();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));};
 const task=e.assistant.start(null,release,workspace);await started.promise;await e.assistant.cancel();await task;
 assert.equal(e.writes,0);assert.equal(e.assistant.state,'cancelled');assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('a failed shared download resumes from its local journal without a sender lookup',async()=>{
 const e=environment();globalThis.fetch=async()=>new Response('bad APK');await e.assistant.start(null,release,workspace);
 assert.equal(e.assistant.state,'error');e.plugin.workspaces.session=async()=>{throw Error('No sender lookup');};
 globalThis.fetch=async()=>new Response(bytes);await e.assistant.resume();
 assert.equal(e.assistant.state,'exchange-ready');assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('retry refuses an exchange path excluded after a previous failed download',async()=>{
 const e=environment();globalThis.fetch=async()=>new Response('bad APK');await e.assistant.start(null,release,workspace);
 e.plugin.folderPolicies.excludes=()=>true;globalThis.fetch=async()=>new Response(bytes);await e.assistant.resume();
 assert.equal(e.assistant.state,'error');assert.equal(e.writes,0);assert.match(e.assistant.message,/исключена/);e.assistant.dispose();
});
test('a shared journal cannot replace the intended APK with a private path',async()=>{
 const e=environment();globalThis.fetch=async()=>new Response('bad APK');await e.assistant.start(null,release,workspace);
 e.assistant.last.delivery.path='.obsidian/'+release.filename;globalThis.fetch=async()=>new Response(bytes);await e.assistant.resume();
 assert.equal(e.assistant.state,'error');assert.equal(e.writes,0);assert.match(e.assistant.message,/Некорректный путь/);e.assistant.dispose();
});
test('shared exchange status is not replaced by a targeted server journal poll',async()=>{
 const e=environment();await e.assistant.start(null,release,workspace);await e.assistant.poll();
 assert.equal(e.assistant.state,'exchange-ready');assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('invalid metadata never opens exchange confirmation or downloads an APK',async()=>{
 const e=environment();globalThis.fetch=async()=>new Response(JSON.stringify({...release,url:'https://evil.invalid/app.apk'}));
 await e.assistant.prepare();assert.equal(globalThis.__assistantDialogs.length,0);assert.match(e.assistant.message,/не прошли проверку/);assert.equal(e.writes,0);e.assistant.dispose();
});
test('a shared exchange requires a connected vault rather than a phone recipient',async()=>{
 const e=environment();e.plugin.folderPolicies.bindingId=async()=>null;globalThis.fetch=async()=>new Response(JSON.stringify(release));
 await e.assistant.prepare();assert.equal(globalThis.__assistantDialogs.length,0);assert.match(e.assistant.message,/подключите хранилище/);assert.equal(e.calls.length,0);e.assistant.dispose();
});
test('disposing during metadata download prevents a stale confirmation dialog',async()=>{
 const e=environment(),pending=defer(),started=defer();globalThis.fetch=()=>{started.resolve();return pending.promise;};
 const task=e.assistant.prepare();await started.promise;e.assistant.dispose();pending.resolve(new Response(JSON.stringify(release)));await task;
 assert.equal(globalThis.__assistantDialogs.length,0);assert.equal(e.calls.length,0);
});
test('release notes stay collapsed while the main description remains short',()=>{
 const e=environment();e.assistant.release={...release,changes:'Long release details '.repeat(100)};
 const el=globalThis.__assistantElement();e.assistant.render(el);
 assert.equal(el.children.some(item=>item.text?.includes('Long release details')),false);
 const details=el.children.find(item=>item.tag==='details');assert.ok(details);assert.equal(details.attr?.open,undefined);
 assert.ok(el.children.find(item=>item.tag==='p'&&item.text?.includes('Заметки и список дел')));e.assistant.dispose();
});

for(const action of ['cancel','dispose'])test(`${action} during Android installer registration cannot report exchange completion`,async()=>{
 const e=environment(),entered=defer(),pending=defer(),adapter=e.plugin.app.vault.adapter,read=adapter.read;globalThis.__assistantAndroid=true;
 adapter.read=async path=>{if(path.endsWith('/installers.json')){entered.resolve();await pending.promise;}return read(path);};
 const task=e.assistant.start(null,release,workspace);await entered.promise;
 if(action==='cancel')await e.assistant.cancel();else e.assistant.dispose();
 pending.resolve();await task;
 assert.notEqual(e.assistant.state,'exchange-ready');
 assert.notEqual(JSON.parse(e.memory.get(e.plugin.pilotDirectory+'/assistant-delivery.json')).delivery.state,'exchange-ready');e.assistant.dispose();
});
test('dispose while the final workspace check is awaiting cannot report completion',async()=>{
 const e=environment(),entered=defer(),pending=defer(),adapter=e.plugin.app.vault.adapter,write=adapter.write;globalThis.__assistantAndroid=true;let registered=false;
 adapter.write=async(path,data)=>{const result=await write(path,data);if(path.endsWith('/installers.json'))registered=true;return result;};
 e.plugin.folderPolicies.bindingId=async()=>{if(registered){entered.resolve();await pending.promise;}return workspace;};
 const task=e.assistant.start(null,release,workspace);await entered.promise;e.assistant.dispose();pending.resolve();await task;
 assert.notEqual(e.assistant.state,'exchange-ready');e.assistant.dispose();
});
test('a delayed ready journal cannot overwrite a subsequent cancellation on disk',async()=>{
 const e=environment(),entered=defer(),pending=defer(),adapter=e.plugin.app.vault.adapter,write=adapter.write;
 adapter.write=async(path,data)=>{if(path.endsWith('/assistant-delivery.json')&&JSON.parse(data).delivery.state==='exchange-ready'){entered.resolve();await pending.promise;}return write(path,data);};
 const task=e.assistant.start(null,release,workspace);await entered.promise;const cancellation=e.assistant.cancel();pending.resolve();await Promise.all([task,cancellation]);
 assert.equal(e.assistant.state,'cancelled');assert.equal(JSON.parse(e.memory.get(e.plugin.pilotDirectory+'/assistant-delivery.json')).delivery.state,'cancelled');e.assistant.dispose();
});
test('concurrent installer registrations preserve both verified files',async()=>{
 const e=environment(),first={path:'Exchange/first.apk',size:release.size,sha256:release.sha256,version:release.version},second={...first,path:'Exchange/second.apk'};
 await Promise.all([e.assistant.rememberInstaller(first),e.assistant.rememberInstaller(second)]);
 const records=JSON.parse(e.memory.get(e.plugin.pilotDirectory+'/companion/installers.json')).installers;
 assert.deepEqual(new Set(records.map(item=>item.path)),new Set([first.path,second.path]));e.assistant.dispose();
});

for(const android of [true,false])test(`${android?'Android':'desktop'} website link explicitly opens the system browser once`,()=>{
 const e=environment(),opened=[];globalThis.__assistantAndroid=android;window.open=(...args)=>opened.push(args);
 const el=globalThis.__assistantElement();e.assistant.render(el);
 const link=el.children.find(item=>item.tag==='a'&&item.href==='https://arcalink.ru/android');assert.ok(link);
 assert.equal(opened.length,0);let prevented=false,stopped=false;
 link.handlers.click({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
 assert.deepEqual(opened,[['https://arcalink.ru/android','_blank','noopener,noreferrer']]);
 assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(e.calls.length,0);assert.equal(e.writes,0);e.assistant.dispose();
});
