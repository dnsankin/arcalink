import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require=createRequire(new URL('../.cache/source/esbuild.config.mjs',import.meta.url));
const compiled=require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('../plugin/mobile-assistant.ts',import.meta.url))],bundle:true,format:'cjs',platform:'node',write:false,external:['obsidian','./localized-obsidian']}).outputFiles[0].text;

function fixture({mobile=false,ownership}={}){
 const effects=[],dialogs=[];
 const forbidden=name=>(...args)=>{effects.push([name,...args]);throw Error('Unexpected side effect: '+name);};
 class Element {
  constructor(tag='div',options={}){this.tag=tag;this.text=options.text||'';this.attr=options.attr||{};this.style={};this.children=[];this.isConnected=true;}
  createEl(tag,options={}){const child=new Element(tag,options);this.children.push(child);return child;}
  createSpan(options={}){return this.createEl('span',options);}
  empty(){this.text='';this.children=[];}
  setText(text){this.text=text;}
  addEventListener(){}
  all(){return [this,...this.children.flatMap(child=>child.all())];}
  textContent(){return [this.text,...this.children.map(child=>child.textContent())].filter(Boolean).join(' ');}
 }
 class Modal {
  constructor(){this.titleEl=new Element();this.contentEl=new Element();this.modalEl=new Element();}
  open(){dialogs.push(this);this.onOpen();}
  close(){this.closed=true;this.onClose?.();}
 }
 class Setting {
  constructor(parent){this.settingEl=parent.createEl('div');}
  setName(text){this.settingEl.createSpan({text});return this;}
  setHeading(){return this;}
  addButton(callback){const button=this.settingEl.createEl('button');button.setButtonText=text=>{button.text=text;return button;};button.setCta=button.setDisabled=()=>button;button.onClick=click=>{button.click=click;return button;};callback(button);return this;}
 }
 const obsidian={Modal,Setting,Notice:class{},Platform:{isMobileApp:mobile,isAndroidApp:mobile},setIcon:(element,name)=>{element.icon=name;}};
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>name==='obsidian'?obsidian:{requestUrl:forbidden('network')},window:{open:forbidden('window.open')},fetch:forbidden('fetch'),navigator:{onLine:true},TextEncoder,TextDecoder,URL,AbortController,crypto:globalThis.crypto});
 const plugin={app:{vault:{getName:()=>'<Личное хранилище>',adapter:new Proxy({},{get:(_,key)=>forbidden('adapter.'+String(key))})}},desktop:{settings:{quickNoteFolder:'Входящие/Заметки',exchangeFolder:'Личное/Обмен'}},companionOwnership:ownership,
  openDesktopSettings:()=>effects.push(['desktop-settings']),openMobileSyncSettings:()=>effects.push(['sync-settings'])};
 const assistant=new module.exports.MobileAssistant(plugin),root=new Element();
 const button=(element,text)=>element.all().find(child=>child.tag==='button'&&child.text===text);
 const open=()=>{assistant.render(root);const entry=button(root,'Открыть справку');assert.ok(entry);entry.click();return dialogs.at(-1);};
 return {assistant,root,plugin,dialogs,effects,button,open};
}

test('help is discoverable and can be revisited without starting sync or touching files',()=>{
 const f=fixture(),first=f.open();
 assert.match(f.root.textContent(),/Как пользоваться/);
 assert.equal(first.titleEl.text,'Как пользоваться Компаньоном');
 const content=first.contentEl.textContent();
 for(const scenario of ['Написать себе','Новая заметка','Задача','Виджеты на экране Android'])assert.ok(content.includes(scenario));
 assert.match(content,/Избранное.*Telegram/);
 assert.match(content,/Заголовок необязателен/);
 assert.match(content,/Задачи\.md/);
 assert.match(content,/Удерживайте пустое место.*Виджеты/);
 assert.match(content,/Поделиться.*ArcaLink Компаньон/);
 assert.deepEqual(f.effects,[]);
 f.button(first.contentEl,'Готово').click();assert.equal(first.closed,true);
 assert.equal(first.contentEl.children.length,0);
 const second=f.open();assert.notEqual(first,second);assert.equal(second.contentEl.textContent(),content);
 assert.deepEqual(f.effects,[]);f.assistant.dispose();
});

test('desktop paths come from this vault and are not presented as phone configuration',()=>{
 const f=fixture(),help=f.open(),content=help.contentEl.textContent();
 const paths=help.contentEl.all().filter(element=>element.tag==='code').map(element=>element.text);
 assert.deepEqual(paths,['<Личное хранилище>','Входящие/Заметки','Личное/Обмен']);
 assert.match(content,/Начальные назначения:.*Быстрые заметки.*Задачи\.md.*Exchange.*Attachments/);
 assert.match(content,/папки телефона и компьютера могут отличаться/);
 assert.match(content,/Этот Obsidian не подтверждает подключение Компаньона на телефоне/);
 assert.deepEqual(f.effects,[]);
 f.button(help.contentEl,'Настройки папок на компьютере').click();
 assert.equal(help.closed,true);assert.deepEqual(f.effects,[['desktop-settings']]);f.assistant.dispose();
});

test('empty desktop quick-note folder means vault root and is reread each time',()=>{
 const f=fixture();f.plugin.desktop.settings.quickNoteFolder='';
 assert.ok(f.open().contentEl.textContent().includes('Корень хранилища'));
 f.plugin.desktop.settings.quickNoteFolder='Другая папка';
 assert.ok(f.open().contentEl.textContent().includes('Другая папка'));f.assistant.dispose();
});

test('mobile Obsidian never labels desktop settings as Android destinations',()=>{
 const f=fixture({mobile:true}),help=f.open();
 assert.equal(help.contentEl.all().some(element=>element.tag==='code'),false);
 assert.equal(f.button(help.contentEl,'Настройки папок на компьютере'),undefined);
 assert.match(help.contentEl.textContent(),/На телефоне проверьте «Настройки» → «Куда сохранять»/);
 assert.deepEqual(f.effects,[]);f.assistant.dispose();
});

for(const [name,ownership,message] of [
 ['pending',{blocksOrdinary:true,committed:false,state:{phase:'held'}},/подключение Компаньона ещё не завершено/],
 ['confirmed',{blocksOrdinary:true,committed:true,state:{phase:'committed'}},/подключение Компаньона подтверждено\. Текущее состояние передачи смотрите на телефоне/],
 ['shared-folder pause',{blocksOrdinary:true,committed:true,state:{phase:'committed',scopeWindow:{status:'open'}}},/передача приостановлена для изменения общих папок/]
])test(`help reports ${name} without asserting delivery or invoking ownership actions`,()=>{
 const f=fixture({ownership}),help=f.open(),content=help.contentEl.textContent();
 assert.match(content,message);
 assert.match(content,/Сохранено на устройстве.*локальный файл/);
 assert.match(content,/Ожидает передачи.*ещё не подтверждает получение/);
 assert.match(content,/В облаке.*Получено устройством.*подтверждают конкретную передачу/);
 assert.match(content,/Free нужно доступное второе устройство/);
 assert.deepEqual(f.effects,[]);
 f.button(help.contentEl,'Настройки синхронизации плагина').click();
 assert.equal(help.closed,true);assert.deepEqual(f.effects,[['sync-settings']]);f.assistant.dispose();
});

test('help keeps theme typography, wraps paths and uses a scrollable content area',()=>{
 const f=fixture(),help=f.open();
 assert.equal(help.contentEl.style.overflowY,'auto');assert.equal(help.contentEl.style.overflowWrap,'anywhere');
 assert.equal(help.modalEl.style.maxHeight,'calc(100dvh - 2rem)');
 const headings=help.contentEl.all().filter(element=>element.tag==='h3');
 assert.equal(headings.length,7);
 for(const heading of headings){assert.equal(heading.children[0].attr['aria-hidden'],'true');assert.ok(heading.children[0].icon);}
 for(const element of help.contentEl.all()){assert.equal(element.style.fontSize,undefined);assert.equal(element.style.color,undefined);assert.equal(element.style.height,undefined);}
 assert.deepEqual(f.effects,[]);f.assistant.dispose();
});
