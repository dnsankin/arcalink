import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationEmbed,publicationHash,replacePublicationLinks} from '../plugin/publication-model.mjs';

test('embed formats support photos, playable video, and attachment downloads',()=>{
 const asset={key:'a'.repeat(64),filename:'photo.png'};
 assert.match(publicationEmbed(asset,true,'<private>'),/<img.*alt="&lt;private&gt;"/);
 assert.match(publicationEmbed({...asset,filename:'movie.mp4'},true),/<video.*controls/);
 assert.match(publicationEmbed({...asset,filename:'sound.mp3'},true),/<audio.*controls/);
 assert.match(publicationEmbed({...asset,filename:'file.pdf'},true),/<a href=/);
 assert.match(publicationEmbed(asset,false),/<a href=/);
});
test('replacements preserve offsets, code text, and reject stale metadata',()=>{
 const source='first ![[photo.png]] and ![[secret.md]]';
 const replacements=[{start:6,end:20,original:'![[photo.png]]',html:'PHOTO'},{start:25,end:39,original:'![[secret.md]]',html:'OMITTED'}];
 assert.equal(replacePublicationLinks(source,replacements),'first PHOTO and OMITTED');
 assert.throws(()=>replacePublicationLinks('changed',replacements),/изменилась/);
});
test('content identity deduplicates by exact bytes',async()=>{
 assert.equal(await publicationHash(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
class Element {
 constructor(){this.children=[];this.style={};this.innerHTML='';}
 createEl(tag,options={}){const el=new Element();el.tag=tag;el.text=options.text||'';el.attrs=options.attr||{};this.children.push(el);return el;}
 setText(value){this.text=value;}
 empty(){this.children=[];}
 removeAttribute(key){delete this.attrs[key];}
}
class Control {
 disabled=false;options={};
 setButtonText(value){this.text=value;return this;}setCta(){return this;}setWarning(){return this;}
 setDisabled(value){this.disabled=value;return this;}setValue(value){this.value=value;return this;}
 addOption(key,value){this.options[key]=value;return this;}onClick(cb){this.click=cb;return this;}onChange(cb){this.change=cb;return this;}
}
async function componentFixture({encrypted=false}={}){
 const require=createRequire(new URL('../.cache/source/esbuild.config.mjs',import.meta.url));
 const compiled=require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('../plugin/publication.ts',import.meta.url))],bundle:true,format:'cjs',platform:'node',write:false,external:['obsidian']}).outputFiles[0].text;
 const settings=[],modals=[],calls=[],writes=new Map(),rendered=[];
 class Setting {
  constructor(parent){this.parent=parent;this.buttons=[];this.descEl=new Element();settings.push(this);}
  setHeading(){return this;}setName(value){this.name=value;return this;}setDesc(value){this.desc=value;return this;}
  addButton(cb){const c=new Control();this.buttons.push(c);cb(c);return this;}
  addText(cb){this.text=new Control();cb(this.text);return this;}
  addDropdown(cb){this.dropdown=new Control();cb(this.dropdown);return this;}
  addToggle(cb){this.toggle=new Control();cb(this.toggle);return this;}
 }
 class Modal {titleEl=new Element();contentEl=new Element();constructor(){modals.push(this);}open(){this.onOpen?.();}close(){this.onClose?.();}}
 class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.extension=path.split('.').pop();this.basename=this.name.slice(0,-this.extension.length-1);this.stat={size:3};}}
 const note=new TFile('note.md'),photo=new TFile('photo.png');
 const markdown='![[photo.png]] ![[secret.md]]',events={},commands=[];
 const app={vault:{on:(event,fn)=>{events[event]=fn;},getAbstractFileByPath:path=>path===note.path?note:null,read:async()=>markdown,readBinary:async()=>new Uint8Array([1,2,3]).buffer,adapter:{exists:async path=>writes.has(path),read:async path=>{if(!writes.has(path))throw Error();return writes.get(path);},write:async(path,value)=>writes.set(path,value)}},workspace:{on:()=>{},getActiveFile:()=>note},metadataCache:{getFirstLinkpathDest:path=>path==='photo.png'?photo:new TFile('secret.md'),getFileCache:()=>({embeds:[{link:'photo.png',original:'![[photo.png]]',position:{start:{offset:0},end:{offset:14}}},{link:'secret.md',original:'![[secret.md]]',position:{start:{offset:15},end:{offset:29}}}]})}};
 const plugin={app,pilotDirectory:'config/plugin',addCommand:c=>commands.push(c),registerEvent:()=>{},workspaces:{auth:()=> 'Basic fake',session:async()=>({workspaceId:'1'.repeat(32)})},unifiedVault:{saved:async()=>({workspaceId:'1'.repeat(32)})},freeRelay:{session:async()=>null},core:{services:{setting:{currentSettings:()=>({encrypt:encrypted})},path:{path2id:async path=>path}}}};
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:()=>({Modal,Setting,TFile,getLinkpath:s=>s.split('#')[0],Notice:class{},Component:class{load(){}unload(){}},MarkdownRenderer:{render:async(app,md,el)=>{rendered.push(md);el.innerHTML=md;}},requestUrl:()=>{throw Error('Real transport forbidden');}}),crypto:webcrypto,TextEncoder,Uint8Array,document:{createElement:()=>new Element()},URL:{createObjectURL:()=> 'blob:fake',revokeObjectURL:()=>{}},Blob:class{},navigator:{clipboard:{writeText:async()=>{}}},btoa:s=>Buffer.from(s,'binary').toString('base64')});
 const publications=new module.exports.NotePublications(plugin);
 publications.api=async(action,body)=>{calls.push({action,body});if(action==='limits')return {limit_bytes:1024*1024*1024};if(action==='list')return {publications:[]};if(action==='preview')return {id:'2'.repeat(32),html:body.html};if(action==='check')return {missing:[]};if(action==='save')return {id:'2'.repeat(32),url:'https://arcalink.ru/p/example'};return {};};
 return {publications,settings,modals,calls,writes,rendered,note,events,commands,app,TFile,plugin};
}

test('publication UI requires preview, excludes embedded notes, and offers storage choice',async()=>{
 const f=await componentFixture();await f.publications.prepare(f.note);
 assert.ok(f.rendered[0].includes('<img '));assert.ok(!f.rendered[0].includes('![[secret.md]]'));
 const dropdown=f.settings.find(s=>s.dropdown).dropdown;
 assert.equal(dropdown.value,'reference');assert.deepEqual(Object.keys(dropdown.options),['reference','copy']);
 const buttons=f.settings.flatMap(s=>s.buttons),preview=buttons.find(b=>b.text==='Предпросмотр'),publish=buttons.find(b=>b.text==='Опубликовать');
 assert.equal(publish.disabled,true);await preview.click();assert.equal(publish.disabled,false);
 dropdown.change('copy');assert.equal(publish.disabled,true);await preview.click();await publish.click();
 const saved=f.calls.find(c=>c.action==='save').body;
 assert.equal(saved.mode,'copy');assert.equal(saved.assets[0].data,undefined,'Known hash must not be uploaded again');
 assert.equal(saved.assets[0].source,'photo.png');
});
test('encrypted vault UI exposes only independent copies',async()=>{
 const f=await componentFixture({encrypted:true});await f.publications.prepare(f.note);
 assert.deepEqual(Object.keys(f.settings.find(s=>s.dropdown).dropdown.options),['copy']);
});
test('renaming notes and folders preserves publication identity without editing source files',async()=>{
 const f=await componentFixture();const first=await f.publications.sourceKey('1'.repeat(32),'folder/note.md');
 await f.publications.renamed({path:'renamed'},'folder');
 assert.equal(await f.publications.sourceKey('1'.repeat(32),'renamed/note.md'),first);
 for(const path of f.writes.keys())assert.equal(path,'config/plugin/publication-index.json');
});

test('failed in-flight upload cannot re-enable publishing after storage choice invalidates preview',async()=>{
 const f=await componentFixture({encrypted:true});await f.publications.prepare(f.note);
 const controls=f.settings.flatMap(s=>s.buttons),preview=controls.find(b=>b.text==='Предпросмотр'),publish=controls.find(b=>b.text==='Опубликовать');
 await preview.click();let fail;
 const original=f.publications.api;
 f.publications.api=(action,body)=>action==='check'?new Promise((_,reject)=>{fail=reject;}):original(action,body);
 const upload=publish.click();await Promise.resolve();
 f.settings.find(s=>s.dropdown).dropdown.change('copy');
 fail(Error('Network failed'));await upload;
 assert.equal(publish.disabled,true,'A new preview is required after the selection changes');
});
test('corrupt publication index is preserved and reported instead of silently replacing stable IDs',async()=>{
 const f=await componentFixture();f.writes.set('config/plugin/publication-index.json','{broken');
 await assert.rejects(f.publications.sourceKey('1'.repeat(32),'note.md'));
 assert.equal(f.writes.get('config/plugin/publication-index.json'),'{broken');
});

test('settings summary loads on selection, shows storage/index state, and refreshes after confirmed revocation',async()=>{
 const f=await componentFixture(),root=new Element();let entries=[{id:'1'.repeat(32),title:'Published note',url:'https://arcalink.ru/p/'+('1'.repeat(32)),mode:'copy',indexed:false,updated:1700000000}];
 f.publications.api=async(action,body)=>{f.calls.push({action,body});if(action==='list')return {publications:entries};if(action==='remove'){entries=[];return {removed:true};}throw Error('Unexpected action');};
 const load=f.publications.render(root);assert.equal(f.calls.length,0,'Hidden settings must not fetch publication lists');await load();
 assert.ok(root.children.some(c=>c.text==='Опубликовано заметок: 1'));
 const row=f.settings.find(s=>s.name==='Published note');assert.match(row.desc,/Независимая копия.*Без индексации/);
 row.buttons.find(b=>b.text==='Снять с публикации').click();assert.equal(f.calls.filter(c=>c.action==='remove').length,0,'Revocation requires explicit confirmation');
 const confirm=f.modals.at(-1),button=f.settings.find(s=>s.parent===confirm.contentEl).buttons[0];await button.click();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.children.some(c=>c.text==='Опубликовано заметок: 0'));assert.equal(f.calls.filter(c=>c.action==='remove').length,1);
 f.publications.init();assert.ok(f.commands.some(c=>c.id==='publish-note'));assert.ok(f.commands.some(c=>c.id==='manage-publications'));
});
test('settings summary reports failed loading and supports retry without claiming an empty account',async()=>{
 const f=await componentFixture(),root=new Element();let failed=true;
 f.publications.api=async()=>{if(failed)throw Error('Offline');return {publications:[]};};
 const load=f.publications.render(root);await load();assert.ok(root.children.some(c=>c.text==='Offline'));
 failed=false;await load();assert.ok(root.children.some(c=>c.text==='Опубликовано заметок: 0'));
});

test('publication preparation and save accept 150 attachments',async()=>{
 const f=await componentFixture(),links=[];let markdown='';
 for(let i=0;i<150;i++){const original='![[photo'+i+'.png]]',start=markdown.length;markdown+=original+'\n';links.push({link:'photo'+i+'.png',original,position:{start:{offset:start},end:{offset:start+original.length}}});}
 f.app.vault.read=async()=>markdown;
 f.app.metadataCache.getFileCache=()=>({embeds:links});
 f.app.metadataCache.getFirstLinkpathDest=path=>new f.TFile(path);
 await f.publications.prepare(f.note);
 const buttons=f.settings.flatMap(s=>s.buttons);
 await buttons.find(b=>b.text==='Предпросмотр').click();
 const publish=buttons.find(b=>b.text==='Опубликовать');assert.equal(publish.disabled,false);await publish.click();
 const saved=f.calls.find(c=>c.action==='save').body;assert.equal(saved.assets.length,150);assert.equal(new Set(saved.assets.map(a=>a.key)).size,150);
});

test('successful publication replaces long form with visible result and close action',async()=>{
 const f=await componentFixture();await f.publications.prepare(f.note);
 const modal=f.modals[0],buttons=f.settings.flatMap(s=>s.buttons);
 await buttons.find(b=>b.text==='Предпросмотр').click();
 await buttons.find(b=>b.text==='Опубликовать').click();
 assert.equal(modal.titleEl.text,'Страница опубликована');
 assert.equal(modal.contentEl.children.some(c=>c.tag==='iframe'||c.tag==='ul'),false);
 assert.equal(modal.contentEl.scrollTop,0);
 assert.equal(modal.contentEl.children.find(c=>c.tag==='a').attrs.target,'_blank');
 const close=f.settings.flatMap(s=>s.buttons).find(b=>b.text==='Закрыть');assert.ok(close);close.click();assert.equal(modal.contentEl.children.length,0);
});

test('publishing status is visible while save is pending and failure allows retry',async()=>{
 const f=await componentFixture();await f.publications.prepare(f.note);
 const buttons=f.settings.flatMap(s=>s.buttons);await buttons.find(b=>b.text==='Предпросмотр').click();
 const publish=buttons.find(b=>b.text==='Опубликовать');let reject;
 f.publications.api=async action=>{if(action==='save')return new Promise((ok,no)=>{reject=no;});throw Error('Unexpected action');};
 const pending=publish.click();assert.equal(publish.text,'Публикуется…');assert.equal(publish.disabled,true);
 reject(Error('Synthetic failure'));await pending;
 assert.equal(publish.text,'Опубликовать');assert.equal(publish.disabled,false);
 assert.equal(f.modals[0].contentEl.children.some(c=>c.tag==='iframe'),true);
});

test('settings update opens matching source, preserves ID and requires preview before save',async()=>{
 const f=await componentFixture(),workspace='1'.repeat(32),key=await f.publications.sourceKey(workspace,f.note.path);
 const p={id:'3'.repeat(32),workspace,source_key:key,title:'Published',url:'https://arcalink.ru/p/id',mode:'reference',updated:1};
 const api=f.publications.api;f.publications.api=async(action,body)=>action==='list'?{publications:[p]}:api(action,body);
 const root=new Element();await f.publications.render(root)();
 const update=f.settings.find(s=>s.name==='Published').buttons.find(b=>b.text==='Обновить публикацию');assert.ok(update);await update.click();
 assert.equal(f.modals.at(-1).titleEl.text,'Обновить публичную заметку');
 const buttons=f.settings.flatMap(s=>s.buttons),save=buttons.find(b=>b.text==='Обновить публикацию'&&b!==update);
 assert.equal(save.disabled,true);assert.equal(f.calls.some(c=>c.action==='save'),false);
 await buttons.find(b=>b.text==='Предпросмотр').click();await save.click();
 assert.equal(f.calls.find(c=>c.action==='save').body.source_key,key);
});

test('updating cannot substitute active note when source is missing or workspace differs',async()=>{
 const f=await componentFixture(),workspace='1'.repeat(32),p={workspace,source_key:'9'.repeat(64)};
 await assert.rejects(f.publications.update(p),/Исходная заметка не найдена/);
 const key=await f.publications.sourceKey(workspace,f.note.path);p.source_key=key;
 await f.publications.renamed({path:'renamed.md'},f.note.path);
 f.app.vault.getAbstractFileByPath=path=>path==='renamed.md'?new f.TFile(path):null;
 let prepared;f.publications.prepare=async file=>{prepared=file.path;};await f.publications.update(p);assert.equal(prepared,'renamed.md');
 await assert.rejects(f.publications.update({...p,workspace:'2'.repeat(32)}),/Переключитесь/);
});
