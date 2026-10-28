import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {sha256} from '../plugin/companion-proof.mjs';
const root=new URL('../',import.meta.url),esbuild=await import(new URL('.cache/source/node_modules/esbuild/lib/main.js',root));
const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('plugin/mobile-assistant.ts',root))],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'obsidian-ui',setup(b){b.onResolve({filter:/^(obsidian|\.\/localized-obsidian)$/},()=>({path:'ui',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:"export class Modal{};export class Notice{};export class Setting{};export const Platform={isAndroidApp:false};export const requestUrl=(options)=>globalThis.__assistantNetwork(options);"}));}}]});
const {MobileAssistant}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
globalThis.window={setTimeout,clearTimeout};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
const bytes=new TextEncoder().encode('APK fixture').buffer;
const release={schema:1,package:'ru.arcalink.companion',version:'0.1.0',versionCode:1,size:bytes.byteLength,sha256:await sha256(bytes),signingCertificateSha256:'a'.repeat(64),filename:'ArcaLink-Android-0.1.0.apk',url:'https://arcalink.ru/downloads/android/ArcaLink-Android-0.1.0.apk',releasedAt:'2026-10-27T00:00:00Z',changes:'test'};
const workspace='a'.repeat(32),target={id:'phone',name:'Phone'};
function defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function environment(){
 const memory=new Map(),calls=[];let writes=0;
 const delivery={id:'b'.repeat(32),sender:'sender',target:'phone',path:'Exchange/ArcaLink Android/0.1.0/'+release.filename,state:'preparing',version:release.version};
 globalThis.fetch=async()=>new Response(bytes);
 globalThis.__assistantNetwork=async options=>{const action=options.url.split('/').at(-1),body=JSON.parse(options.body);calls.push({action,body});return {status:200,json:action==='create'?{delivery:{...delivery,path:body.path},existing:false}:{delivery:{...delivery,state:action==='cancel'?'cancelled':'waiting'}}};};
 const plugin={pilotDirectory:'.obsidian/plugins/arcalink-sync',unifiedVault:{base:'https://arcalink.ru/sync/api'},workspaces:{session:async()=>({deviceId:'sender'})},desktop:{settings:{exchangeFolder:'Exchange'}},folderPolicies:{bindingId:async()=>workspace,credentialsAuth:async()=>({auth:'Basic fixture'}),excludes:()=>false},folders:{contains:()=>false},core:{services:{vault:{isTargetFile:async()=>true,isFileSizeTooLarge:()=>false}}},app:{vault:{createBinary:async(path,data)=>{writes++;memory.set(path,data);},createFolder:async path=>memory.set(path,'folder'),adapter:{exists:async path=>memory.has(path),write:async(path,data)=>memory.set(path,data),writeBinary:async(path,data)=>{writes++;memory.set(path,data);},readBinary:async path=>memory.get(path),rename:async(from,to)=>{memory.set(to,memory.get(from));memory.delete(from);},remove:async path=>memory.delete(path)}}}};
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
