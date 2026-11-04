import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(source+'esbuild.config.mjs');
const output=await require('esbuild').build({entryPoints:[fileURLToPath(new URL('../plugin/local-backups.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,nodePaths:[source+'node_modules'],plugins:[{name:'backup-ui-obsidian',setup(build){build.onResolve({filter:/^\.\/localized-obsidian$/},()=>({path:'language',namespace:'backup-language'}));build.onLoad({filter:/.*/,namespace:'backup-language'},()=>({contents:'export const localizeMessage = message => globalThis.__backupUILocalize(message);'}));build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'backup-ui'}));build.onLoad({filter:/.*/,namespace:'backup-ui'},()=>({contents:'export class Setting {constructor(el){return new globalThis.__backupUISetting(el)}} export class Modal {constructor(){return new globalThis.__backupUIModal()}} export class Notice {} export class TFile {}'}));}}]});
const Module=require('node:module'),mod=new Module('local-backup-ui-fixture');mod.filename=source+'local-backup-ui-fixture.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output.outputFiles[0].text,mod.filename);const {LocalBackups}=mod.exports;
class Element{
 constructor(doc){this.ownerDocument=doc;this.children=[];this.textContent='';this.value='';this.isConnected=true;this.hidden=false;this.emptied=0;this.listeners={};}
 empty(){this.emptied++;for(const c of this.children)c.isConnected=false;this.children=[];this.textContent='';}
 addClass(){return this;}
 setText(text){this.textContent=text;return this;}
 createEl(tag,options={}){const el=new Element(this.ownerDocument);el.tag=tag;el.textContent=options.text||'';this.children.push(el);return el;}
 createDiv(){return this.createEl('div');}
 addEventListener(name,fn){this.listeners[name]=fn;}
}
class Component{
 constructor(el,kind){this.kind=kind;this.inputEl=el.createEl('input');this.buttonEl=this.inputEl;this.value='';}
 setCta(){return this;}
 setValue(value){this.value=value;this.inputEl.value=value;return this;}getValue(){return this.inputEl.value;}
 setDisabled(disabled){this.disabled=disabled;return this;}setPlaceholder(){return this;}setButtonText(text){this.text=text;return this;}
 onChange(fn){this.change=fn;return this;}onClick(fn){this.click=fn;return this;}
}
class Setting{
 constructor(el){this.el=el.createDiv();this.controls=[];el.ownerDocument.settings.push(this);}
 setName(name){this.name=name;return this;}setDesc(){return this;}
 add(kind,fn){const c=new Component(this.el,kind);this.controls.push(c);fn(c);return this;}
 addText(fn){return this.add('text',fn);}addToggle(fn){return this.add('toggle',fn);}addButton(fn){return this.add('button',fn);}
}
globalThis.__backupUILocalize=message=>message;globalThis.__backupUISetting=Setting;globalThis.window=globalThis;
const state=(count=0)=>({settings:{enabled:true,days:14,maxBytes:2048*1048576},usedBytes:1234,versions:Array.from({length:count},(_,i)=>({id:'version-'+i,path:`Folder/file-${i}.md`,time:1000+i,size:42}))});
function fixture(count=0){const doc={settings:[],activeElement:null},el=new Element(doc),b=new LocalBackups({app:{vault:{getFiles:()=>[],adapter:{getResourcePath:path=>'app://vault/'+path}}}});let current=state(count),calls=0,pending;
 b.enabled=true;b.store={state:()=>{calls++;return pending||Promise.resolve(current);},configure:async patch=>{current={...current,settings:{...current.settings,...patch}};return current.settings;}};
 return {doc,el,b,get calls(){return calls;},setState:s=>{current=s;},block:()=>{let resolve;pending=new Promise(r=>{resolve=r;});return value=>{pending=null;resolve(value);};},setting:name=>doc.settings.find(x=>x.name===name)};
}
test('progress refresh preserves form nodes, search text and focused unfinished number input',async()=>{const f=fixture(3000);await f.b.render(f.el);const search=f.setting('Поиск по пути файла').controls[0],days=f.setting('Срок хранения, дней').controls[0],toggle=f.setting('Включить резервирование').controls[0],rootNodes=[...f.el.children];search.setValue('file-29');search.change('file-29');days.setValue('7');f.doc.activeElement=days.inputEl;
 for(let i=0;i<30;i++){f.b.progress='Сохранено '+i;await f.b.render(f.el);}
 assert.deepEqual(f.el.children,rootNodes);assert.equal(f.el.emptied,1);assert.equal(days.getValue(),'7');assert.equal(f.doc.activeElement,days.inputEl);assert.equal(search.getValue(),'file-29');assert.equal(f.setting('Включить резервирование').controls[0],toggle);
 const list=f.el.children.at(-1);assert.ok(list.children.length<=101);assert.ok(f.doc.settings.slice(-100).some(x=>x.name?.includes('file-29')));
});
test('slow state reads coalesce and never erase controls; stop works before the read completes',async()=>{const f=fixture();await f.b.render(f.el);const finish=f.block(),baseline=f.calls;f.b.progress='Читается большое видео';const first=f.b.render(f.el);f.b.busy=true;const pending=[first,...Array.from({length:20},()=>f.b.render(f.el))];assert.equal(f.calls,baseline+1);assert.equal(f.el.emptied,1);const actions=f.setting('Снимок текущих файлов'),stop=actions.controls[1];assert.equal(stop.buttonEl.hidden,false);stop.click();assert.equal(f.b.stop,true);assert.equal(stop.disabled,true);finish(state(1200));await Promise.all(pending);assert.equal(f.el.emptied,1);assert.equal(actions,f.setting('Снимок текущих файлов'));
});
test('the first render exposes cancellation while history is still loading',async()=>{const f=fixture(),finish=f.block();f.b.busy=true;const loading=f.b.render(f.el);const stop=f.setting('Снимок текущих файлов').controls[1];assert.equal(stop.buttonEl.hidden,false);stop.click();assert.equal(f.b.stop,true);finish(state());await loading;assert.equal(f.el.emptied,1);});
test('frequent snapshot progress does not enqueue history reads; finishing refreshes counters',async()=>{const f=fixture(1000);await f.b.render(f.el);const baseline=f.calls;f.b.busy=true;for(let i=0;i<20;i++){f.b.progress='Сохранено '+i;await f.b.render(f.el);}assert.equal(f.calls,baseline);f.setState(state(2000));f.b.busy=false;await f.b.render(f.el);assert.equal(f.calls,baseline+1);assert.ok(f.el.children.some(x=>x.textContent.includes('Версий: 2000.')));assert.equal(f.setting('Снимок текущих файлов').controls[1].buttonEl.hidden,true);});
test('state failures keep the existing form and cancellation controls',async()=>{const f=fixture();await f.b.render(f.el);const rootNodes=[...f.el.children];f.b.store.state=async()=>{throw Error('disk read failed');};await f.b.render(f.el);assert.deepEqual(f.el.children,rootNodes);assert.equal(f.el.emptied,1);assert.ok(f.b.error.includes('Не удалось'));});
test('disabling stops the snapshot immediately even when persistence is still waiting',async()=>{const f=fixture();let release;f.b.store.configure=()=>new Promise(r=>{release=()=>r({...state().settings,enabled:false});});f.b.stop=false;const job=f.b.configure({enabled:false});assert.equal(f.b.stop,true);release();await job;clearTimeout(f.b.refreshTimer);});
test('a delayed old state cannot undo a newer user toggle',async()=>{const f=fixture();await f.b.render(f.el);const toggle=f.setting('Включить резервирование').controls[0];let release,reads=0;f.b.store.state=()=>++reads===1?new Promise(r=>{release=r;}):Promise.resolve({...state(),settings:{...state().settings,enabled:false}});const loading=f.b.render(f.el);toggle.setValue(false);await f.b.configure({enabled:false});release(state());await loading;assert.equal(toggle.getValue(),false);assert.equal(f.b.enabled,false);clearTimeout(f.b.refreshTimer);});
test('the first-render toggle can disable backups without waiting for history',async()=>{const f=fixture(3000),finish=f.block();f.b.busy=true;const loading=f.b.render(f.el),toggle=f.setting('Включить резервирование').controls[0];assert.notEqual(toggle.disabled,true,'toggle must not wait for version statistics');toggle.setValue(false);await toggle.change(false);assert.equal(f.b.stop,true);assert.equal(f.b.enabled,false);assert.equal(f.calls,1,'configure must not request full history');finish(state(3000));await loading;assert.equal(toggle.getValue(),false);clearTimeout(f.b.refreshTimer);});

test('comparison skips huge current files before opening a stream',async t=>{
 const f=fixture();f.b.raw={stat:async()=>({type:'file',size:1024**3}),read:()=>assert.fail('unbounded text read'),readBinary:()=>assert.fail('unbounded byte read')};
 t.mock.method(globalThis,'fetch',()=>assert.fail('large file must not be fetched'));
 assert.match(await f.b.comparisonText('a.md'),/больше 1 МиБ/);
});
test('comparison cancels a growing file as soon as its stream exceeds the byte limit',async t=>{
 const f=fixture();f.b.raw={stat:async()=>({type:'file',size:10})};let pulls=0,cancelled=0;
 t.mock.method(globalThis,'fetch',async()=>({ok:true,body:new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(400000));},cancel(){cancelled++;}},{highWaterMark:0})}));
 assert.match(await f.b.comparisonText('growing.md'),/больше 1 МиБ/);assert.equal(pulls,3);assert.equal(cancelled,1);
});
test('bounded comparison decodes split UTF-8 and distinguishes missing from unreadable content',async t=>{
 const f=fixture(),bytes=new TextEncoder().encode('Я🔒 text');f.b.raw={stat:async()=>({type:'file',size:bytes.length})};
 const fetch=t.mock.method(globalThis,'fetch',async()=>({ok:true,body:new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}})}));
 assert.equal(await f.b.comparisonText('a.md'),'Я🔒 text');f.b.raw.stat=async()=>null;assert.equal(await f.b.comparisonText('a.md'),'Файл отсутствует');assert.equal(fetch.mock.callCount(),1);
 f.b.raw.stat=async()=>({type:'file',size:5});fetch.mock.mockImplementation(async()=>{throw Error('unavailable');});assert.match(await f.b.comparisonText('a.md'),/Не удалось прочитать/);
});
test('a skipped large comparison still offers restoration of the saved version',async t=>{
 const f=fixture();let modal,released=0,restored;globalThis.__backupUIModal=class{constructor(){modal=this;this.titleEl=new Element(f.doc);this.contentEl=new Element(f.doc);this.modalEl=new Element(f.doc);}open(){this.opened=true;}close(){this.closed=true;}};
 const version={id:'saved',path:'a.md',time:1000,size:3};f.b.store.retain=async()=>({version,release:async()=>{released++;}});f.b.store.stream=async function*(){yield new TextEncoder().encode('old');};f.b.raw={stat:async()=>({type:'file',size:1024**3})};f.b.restore=async id=>{restored=id;};
 t.mock.method(globalThis,'fetch',()=>assert.fail('large file must not be fetched'));
 await f.b.openVersion(version);assert.equal(modal.opened,true);assert.equal(released,1);
 const restore=f.doc.settings.flatMap(s=>s.controls).find(c=>c.text==='Подтверждаю восстановление');assert.ok(restore);await restore.click();assert.equal(restored,'saved');assert.equal(modal.closed,true);
});

test('comparison localizes status messages but preserves current user text verbatim',async t=>{
 const f=fixture();f.b.raw={stat:async()=>({type:'file',size:5})};t.mock.method(globalThis,'__backupUILocalize',message=>'translated: '+message);
 t.mock.method(globalThis,'fetch',async()=>({ok:true,body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('Файл отсутствует'));c.close();}})}));
 assert.equal(await f.b.comparisonText('a.md'),'Файл отсутствует');f.b.raw.stat=async()=>null;assert.equal(await f.b.comparisonText('a.md'),'translated: Файл отсутствует');
});
