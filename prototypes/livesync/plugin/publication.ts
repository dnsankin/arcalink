import {Component,MarkdownRenderer,Modal,Notice,Setting,TFile,getLinkpath,requestUrl} from 'obsidian';
import {publicationHash,publicationEmbed,publicationTypes,replacePublicationLinks,MAX_PUBLICATION_BYTES,publicationAttribute} from './publication-model.mjs';
import {bytesToBase64} from './folder-model.mjs';
import {isFreeRelayConnection} from './free-relay-settings.mjs';
import {responseError} from './pilot-http.mjs';
const BASE='https://arcalink.ru/sync/publish/api/';

export class NotePublications {
 private indexQueue:Promise<any>=Promise.resolve();
 constructor(private plugin:any){}
 get indexPath(){return this.plugin.pilotDirectory+'/publication-index.json';}
 async index(){
  const adapter=this.plugin.app.vault.adapter;if(!await adapter.exists(this.indexPath))return {};
  try{const value=JSON.parse(await adapter.read(this.indexPath));if(!value||Array.isArray(value)||typeof value!=='object'||Object.values(value).some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))throw Error();return value;}
  catch{throw Error('Не удалось прочитать список публикаций. Файл сохранён; восстановите publication-index.json из резервной копии.');}
 }
 async sourceKey(workspace:string,path:string){
  return this.indexQueue=this.indexQueue.catch(()=>{}).then(async()=>{const index=await this.index(),key=workspace+':'+path;index[key]??=await publicationHash(new TextEncoder().encode(key));await this.plugin.app.vault.adapter.write(this.indexPath,JSON.stringify(index));return index[key];});
 }
 async renamed(file:TFile,old:string){
  await (this.indexQueue=this.indexQueue.catch(()=>{}).then(async()=>{const index=await this.index();for(const key of Object.keys(index)){const path=key.slice(33);if(path===old||path.startsWith(old+'/')){index[key.slice(0,33)+file.path+path.slice(old.length)]=index[key];delete index[key];}}await this.plugin.app.vault.adapter.write(this.indexPath,JSON.stringify(index));}));
 }
 init(){
  this.plugin.registerEvent(this.plugin.app.vault.on('rename',(file:any,old:string)=>{void this.renamed(file,old).catch(e=>new Notice(e.message));}));
  this.plugin.addCommand({id:'publish-note',name:'Опубликовать заметку в интернете',callback:()=>this.open(this.plugin.app.workspace.getActiveFile())});
  this.plugin.addCommand({id:'manage-publications',name:'Управление публичными заметками',callback:()=>void this.manage().catch(e=>new Notice(e.message))});
  this.plugin.registerEvent(this.plugin.app.workspace.on('file-menu',(menu:any,file:any)=>{
   if(file instanceof TFile&&file.extension==='md')menu.addItem((item:any)=>item.setTitle('Опубликовать в интернете').setIcon('globe').onClick(()=>this.open(file)));
  }));
 }
 open(file:TFile|null){if(!file||file.extension!=='md'){new Notice('Выберите Markdown-заметку');return;}void this.prepare(file).catch(e=>new Notice(e.message));}
 async api(action:string,body:any){
  // Reuse the normal account identity without changing transport settings or refreshing sync sessions.
  const auth=this.plugin.workspaces.auth();
  const saved=await this.plugin.unifiedVault.saved();const free=await this.plugin.freeRelay.session();
  const token=free?.accessToken||saved?.auth?.accessToken;
  const authorization=isFreeRelayConnection(this.plugin.core.services.setting.currentSettings())&&token?'Bearer '+token:auth;
  const r=await requestUrl({url:BASE+action,method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body),throw:false});
  if(r.status!==200)throw Error(responseError(r,'Публикация временно недоступна'));
  return r.json;
 }
 async prepare(file:TFile){
  const app=this.plugin.app,saved=await this.plugin.unifiedVault.saved(),session=await this.plugin.workspaces.session();
  const workspace=saved?.workspaceId||session.workspaceId;
  if(!workspace)throw Error('Сначала подключите серверное хранилище');
  const source_key=await this.sourceKey(workspace,file.path);
  const list=await this.api('list',{}),old=list.publications.find((p:any)=>p.source_key===source_key);
  const markdown=await app.vault.read(file),cache=app.metadataCache.getFileCache(file);
  if(!cache)throw Error('Дождитесь индексации заметки и повторите публикацию');
  const assets:any[]=[],byPath=new Map<string,any>(),replacements:any[]=[],warnings:string[]=[];
  for(const link of [...(cache.embeds||[]).map((v:any)=>({...v,embedded:true})),...(cache.links||[]).map((v:any)=>({...v,embedded:false}))]){
   const target=app.metadataCache.getFirstLinkpathDest(getLinkpath(link.link),file.path);
   if(!target||target.extension==='md'){
    if(link.embedded){replacements.push({start:link.position.start.offset,end:link.position.end.offset,original:link.original,html:'[Вложенная заметка или внешнее медиа не опубликованы]'});warnings.push(link.link);}
    continue;
   }
   if(!publicationTypes[target.extension.toLowerCase()]){warnings.push(target.path);replacements.push({start:link.position.start.offset,end:link.position.end.offset,original:link.original,html:'[Неподдерживаемое вложение]'});continue;}
   let asset=byPath.get(target.path);
   if(!asset){
    if(assets.length>=100||target.stat.size>MAX_PUBLICATION_BYTES)throw Error('Лимит публикации: 100 вложений и 32 МиБ суммарно');
    const bytes=new Uint8Array(await app.vault.readBinary(target));
    asset={key:await publicationHash(new TextEncoder().encode(target.path)),hash:await publicationHash(bytes),filename:target.name,size:bytes.length,source:await this.plugin.core.services.path.path2id(target.path),bytes};
    assets.push(asset);byPath.set(target.path,asset);
    if(assets.reduce((sum,a)=>sum+a.size,0)>MAX_PUBLICATION_BYTES)throw Error('Суммарный размер вложений больше 32 МиБ');
   }
   replacements.push({start:link.position.start.offset,end:link.position.end.offset,original:link.original,html:publicationEmbed(asset,link.embedded,link.displayText||target.name)});
  }
  const component=new Component();component.load();
  try{
   const rendered=document.createElement('div');
   await MarkdownRenderer.render(app,replacePublicationLinks(markdown,replacements),rendered,file.path,component);
   // The server sanitizes again; local resource URLs and arbitrary plugin HTML are never trusted.
   const payload={source_key,workspace,title:old?.title||file.basename,html:rendered.innerHTML,assets:assets.map(({bytes,...a})=>a),indexed:!!old?.indexed,mode:this.plugin.core.services.setting.currentSettings().encrypt?'copy':old?.mode||'reference'};
   new PublicationModal(this,assets,payload,old,warnings,!!this.plugin.core.services.setting.currentSettings().encrypt).open();
  }finally{component.unload();}
 }
 async manage(){
  const list=await this.api('list',{}),modal=new Modal(this.plugin.app);modal.titleEl.setText('Публичные заметки');
  if(!list.publications.length)modal.contentEl.createEl('p',{text:'Опубликованных заметок пока нет'});
  for(const p of list.publications)new Setting(modal.contentEl).setName(p.title).setDesc(p.url).addButton(b=>b.setButtonText('Скопировать ссылку').onClick(()=>void navigator.clipboard.writeText(p.url).catch(()=>new Notice(p.url)))).addButton(b=>b.setButtonText('Снять с публикации').onClick(()=>{const confirm=new Modal(this.plugin.app);confirm.titleEl.setText('Снять с публикации?');confirm.contentEl.createEl('p',{text:p.title+' — страница и её вложения станут недоступны по публичным ссылкам.'});new Setting(confirm.contentEl).addButton(c=>c.setButtonText('Снять с публикации').setWarning().onClick(async()=>{c.setDisabled(true);try{await this.api('remove',{id:p.id});confirm.close();modal.close();new Notice('Публикация удалена');}catch(e){c.setDisabled(false);new Notice((e as Error).message);}}));confirm.open();}));
  modal.open();
 }
 get app(){return this.plugin.app;}
}

class PublicationModal extends Modal {
 private previewVersion=0;
 constructor(private owner:NotePublications,private assets:any[],private payload:any,private old:any,private warnings:string[],private encrypted:boolean){super(owner.app);}
 onOpen(){
  this.titleEl.setText(this.old?'Обновить публичную заметку':'Опубликовать заметку');
  this.contentEl.createEl('p',{text:'Содержимое и перечисленные вложения будут доступны всем, у кого есть ссылка. Обновление — только вручную. Для видео нужен поддерживаемый браузером кодек.'});
  new Setting(this.contentEl).setName('Заголовок страницы').addText(t=>t.setValue(this.payload.title).onChange(v=>{this.payload.title=v;this.previewVersion++;publish.setDisabled(true);}));
  const info=this.contentEl.createEl('p');
  const explain=()=>info.setText(this.payload.mode==='reference'?'Без отдельной копии. Изменение, удаление исходника или окончание хранения облачной копии сделает вложение недоступным до обновления публикации.':'Отдельный публичный оригинал. Одинаковые файлы в ваших публикациях хранятся один раз. Снятие публикации не удаляет исходники.');
  new Setting(this.contentEl).setName('Хранение вложений').setDesc(this.encrypted?'Зашифрованное хранилище: нужна отдельная открытая копия.':'Выберите зависимость от исходного хранилища.').addDropdown(d=>{if(!this.encrypted)d.addOption('reference','Использовать исходные вложения');d.addOption('copy','Создать независимую копию').setValue(this.payload.mode).onChange(v=>{this.payload.mode=v;explain();this.previewVersion++;frame.removeAttribute('srcdoc');publish.setDisabled(true);});});explain();
  new Setting(this.contentEl).setName('Разрешить индексацию поисковиками').setDesc('Отключение индексации не ограничивает доступ по ссылке.').addToggle(t=>t.setValue(this.payload.indexed).onChange(v=>{this.payload.indexed=v;}));
  this.contentEl.createEl('h3',{text:'Публикуемые вложения'});
  const ul=this.contentEl.createEl('ul');for(const a of this.assets)ul.createEl('li',{text:a.filename+' · '+(a.size/1024/1024).toFixed(2)+' МиБ'});
  if(!this.assets.length)this.contentEl.createEl('p',{text:'Нет вложений'});
  if(this.warnings.length)this.contentEl.createEl('p',{text:'Не включены в публикацию: '+this.warnings.join(', ')});
  this.contentEl.createEl('p',{text:'Ссылки на другие заметки не публикуют эти заметки. Внешние iframe и произвольный HTML отключены.'});
  const frame=this.contentEl.createEl('iframe',{cls:'arcalink-publication-preview',attr:{sandbox:'',title:'Предпросмотр публичной заметки'}});
  let publish:any;const controls=new Setting(this.contentEl);
  controls.addButton(b=>b.setButtonText('Предпросмотр').onClick(async()=>{b.setDisabled(true);publish.setDisabled(true);const version=++this.previewVersion;try{
   const result=await this.owner.api('preview',this.payload);
   if(version!==this.previewVersion)return;
   let html=result.html;
   for(const a of this.assets){const url='data:'+publicationTypes[a.filename.split('.').pop().toLowerCase()]+';base64,'+bytesToBase64(a.bytes);html=html.split('/p/'+result.id+'/assets/'+a.key).join(url);}
   frame.srcdoc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; media-src data:; style-src \'unsafe-inline\'"><style>body{font:16px system-ui;line-height:1.65;padding:20px;color:#eee;background:#202027}img,video{max-width:100%}pre{white-space:pre-wrap}</style><h1>'+publicationAttribute(this.payload.title)+'</h1>'+html;
   publish.setDisabled(false);
  }catch(e){new Notice((e as Error).message);}finally{b.setDisabled(false);}}));
  controls.addButton(b=>{publish=b;b.setButtonText(this.old?'Обновить публикацию':'Опубликовать').setCta().setDisabled(true).onClick(async()=>{b.setDisabled(true);const version=this.previewVersion;try{
   const snapshot={...this.payload};let assets=snapshot.assets;
   if(snapshot.mode==='copy'){const {missing}=await this.owner.api('check',{hashes:assets.map((a:any)=>a.hash)});assets=assets.map((a:any)=>({...a,...(missing.includes(a.hash)?{data:bytesToBase64(this.assets.find(v=>v.key===a.key).bytes)}:{})}));}
   const result=await this.owner.api('save',{...snapshot,assets});this.old=result;
   const link=new Setting(this.contentEl).setName('Страница опубликована').setDesc(result.url);link.addButton(c=>c.setButtonText('Скопировать ссылку').onClick(()=>void navigator.clipboard.writeText(result.url).catch(()=>new Notice(result.url))));
   new Notice('Публичная страница сохранена');
  }catch(e){b.setDisabled(version!==this.previewVersion);new Notice((e as Error).message);}});});
 }
 onClose(){this.previewVersion++;this.contentEl.empty();}
}
