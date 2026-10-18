import {requestPilot,responseData,responseError} from './pilot-http.mjs';
import {Notice,Modal,Setting,TFile,editorInfoField,requestUrl} from 'obsidian';
import {Compartment,EditorState,StateEffect,Prec} from '@codemirror/state';
import {EditorView,ViewPlugin,keymap} from '@codemirror/view';
import * as Y from 'yjs';import {yCollab,yUndoManagerKeymap} from 'y-codemirror.next';
import {HocuspocusProvider} from '@hocuspocus/provider';import {IndexeddbPersistence} from 'y-indexeddb';
import {textChange} from './collab-diff.mjs';
const FOLDER='ArcaLink Shared',BASE='https://arcalink.ru/sync/api';
export const reserved=(path:string)=>path.toLowerCase()===FOLDER.toLowerCase()||path.toLowerCase().startsWith(FOLDER.toLowerCase()+'/');
export class CollaborativeNotes{
 plugin:any;app:any;entries=new Map<string,any>();records:any[]=[];views=new Map<any,any>();disposed=false;registryQueue=Promise.resolve();
 constructor(plugin:any){this.plugin=plugin;this.app=plugin.app;}
 get registry(){return this.plugin.pilotDirectory+'/collaboration.json';}
 get socketUrl(){return this.plugin.manifest.id==='arcalink-free-lab'?'wss://arcalink.ru/sync-lab/unified/collab/':'wss://arcalink.ru/sync/collab/';}
 auth(){const s=this.plugin.core.services.setting.currentSettings();if(!s.isConfigured||!s.couchDB_USER.startsWith('pilot_'))throw Error('Сначала войдите в аккаунт пилота');return 'Basic '+btoa(s.couchDB_USER+':'+s.couchDB_PASSWORD);}
 async api(action:string,body:any){const r=await requestPilot(requestUrl,{url:this.plugin.unifiedVault.base+'/collab/'+action,method:'POST',headers:{Authorization:this.auth(),'Content-Type':'application/json'},body:JSON.stringify(body),throw:false});if(r.status!==200){const error:any=Error(responseError(r,'Совместные заметки недоступны'));error.status=r.status;error.code=responseData(r)?.error_code;throw error;}return responseData(r);}
 async init(){if(await this.app.vault.adapter.exists(this.registry))this.records=JSON.parse(await this.app.vault.adapter.read(this.registry));
  const views=this.views,attach=(view:any,force=false)=>this.attach(view,force),filePath=(view:any)=>this.filePath(view);this.plugin.registerEditorExtension(ViewPlugin.fromClass(class{
   constructor(view:any){(this as any).view=view;views.set(view,{path:null,compartment:new Compartment()});window.setTimeout(()=>{void attach(view);},0);}
   update(update:any){const info=views.get(update.view);if(info?.path!==filePath(update.view))window.setTimeout(()=>{void attach(update.view);},0);}
   destroy(){const view=(this as any).view,info=views.get(view);if(info?.added)queueMicrotask(()=>{try{view.dispatch({effects:info.compartment.reconfigure([])});}catch{/* The editor may already be destroyed. */}});views.delete(view);}
  }));
  this.plugin.registerEvent(this.app.vault.on('modify',(file:any)=>{void this.external(file).catch(e=>new Notice(e.message));}));
  this.plugin.registerEvent(this.app.vault.on('delete',(file:any)=>{const r=this.records.find(r=>r.path===file.path);if(!r)return;this.records=this.records.filter(x=>x!==r);void this.save();const e=this.entries.get(r.id);this.entries.delete(r.id);for(const v of this.views.keys())setTimeout(()=>void this.attach(v,true),0);setTimeout(()=>{e?.provider?.destroy();e?.persistence?.destroy();e?.undo?.destroy();e?.doc?.destroy();},500);}));
  this.plugin.registerEvent(this.app.vault.on('rename',(file:any,old:string)=>{void this.rename(file,old).catch(e=>new Notice(e.message));}));
  this.plugin.addCommand({id:'collab-create',name:'Совместные заметки: создать',callback:()=>this.prompt('Новая совместная заметка','Название',async title=>this.create(title))});
  this.plugin.addCommand({id:'collab-join',name:'Совместные заметки: присоединиться',callback:()=>this.prompt('Присоединиться к заметке','Код приглашения',async code=>this.join(code))});
  this.plugin.addCommand({id:'collab-invite-editor',name:'Совместные заметки: пригласить редактора',callback:()=>void this.inviteActive('editor')});
  this.plugin.addCommand({id:'collab-invite-viewer',name:'Совместные заметки: пригласить читателя',callback:()=>void this.inviteActive('viewer')});
  this.plugin.addCommand({id:'collab-revoke',name:'Совместные заметки: отозвать приглашения и доступ участников',callback:()=>{const r=this.records.find(r=>r.path===this.app.workspace.getActiveFile()?.path);if(r)this.prompt('Отозвать доступ всех участников','Введите ОТОЗВАТЬ',async text=>{if(text!=='ОТОЗВАТЬ')throw Error('Отзыв отменён');await this.api('revoke',{id:r.id});new Notice('Доступ участников отозван');});}});
  for(const r of this.records)void this.ensure(r).catch(e=>new Notice(e.message));
 }
 prompt(title:string,label:string,task:(text:string)=>Promise<any>){const m=new Modal(this.app);m.titleEl.setText(title);let value='';new Setting(m.contentEl).setName(label).addText(t=>t.onChange(v=>value=v.trim()));new Setting(m.contentEl).addButton(b=>b.setButtonText('Продолжить').setCta().onClick(async()=>{b.setDisabled(true);try{await task(value);m.close();}catch(e:any){new Notice(e.message);}finally{b.setDisabled(false);}}));m.open();}
 async save(){this.registryQueue=this.registryQueue.catch(()=>{}).then(()=>this.app.vault.adapter.write(this.registry,JSON.stringify(this.records)));await this.registryQueue;}
 async add(result:any){let r=this.records.find(r=>r.id===result.id);const previous=this.entries.get(result.id);if(previous&&(previous.denied||r?.role!==result.role)){this.entries.delete(result.id);previous.provider?.destroy();previous.persistence?.destroy();previous.undo?.destroy();previous.doc.destroy();}if(!r){r={id:result.id,title:result.title,role:result.role,path:FOLDER+'/'+result.id+'.md'};this.records.push(r);}else r.role=result.role;
  if(!await this.app.vault.adapter.exists(FOLDER))await this.app.vault.createFolder(FOLDER);
  if(!this.app.vault.getAbstractFileByPath(r.path))await this.app.vault.create(r.path,'');await this.save();await this.plugin.initializeCloudFeatures();const e=await this.ensure(r);await this.app.workspace.getLeaf(false).openFile(this.app.vault.getAbstractFileByPath(r.path));return r;}
 async create(title:string,text=''){return this.add(await this.api('create',{title,text}));}
 async join(code:string){const result=await this.api('join',{code});if(result.kind==='folder'){this.plugin.folders.mountDialog(result);return;}return this.add(result);}
 async invite(id:string,role:string){return (await this.api('invite',{id,role})).code;}
 async inviteActive(role:string){try{const r=this.records.find(r=>r.path===this.app.workspace.getActiveFile()?.path);if(!r)throw Error('Откройте совместную заметку');const code=await this.invite(r.id,role);const m=new Modal(this.app);m.titleEl.setText('Приглашение: '+role);m.contentEl.createEl('p',{text:'Передайте этот код участнику. Его аккаунт должен быть подключён к пилоту. Сервер видит текст этой заметки.'});new Setting(m.contentEl).addText(t=>t.setValue(code).setDisabled(true)).addButton(b=>b.setButtonText('Копировать').onClick(()=>void navigator.clipboard.writeText(code)));m.open();}catch(e:any){new Notice(e.message);}}
 filePath(view:any){return view.state.field(editorInfoField,false)?.file?.path||null;}
 async ensure(record:any){if(this.entries.has(record.id))return await this.entries.get(record.id).promise;
  const entry:any={record,doc:new Y.Doc(),provider:null,persistence:null,ready:false,denied:false,materializing:Promise.resolve(),lastDisk:null,diskState:null};this.entries.set(record.id,entry);
  entry.promise=(async()=>{entry.text=entry.doc.getText('markdown');entry.undo=new Y.UndoManager(entry.text);
   entry.persistence=new IndexeddbPersistence('arcalink-shared:'+this.plugin.core.services.setting.currentSettings().couchDB_USER+':'+record.id,entry.doc);await entry.persistence.whenSynced;
   if(this.disposed)return entry;
   try{const access=await this.api('authorize',{id:record.id});record.role=access.role;await this.save();}catch(e:any){if(e.code==='collaboration_retention_paused')this.storagePaused(entry);else if([400,401,403,404].includes(e.status)){entry.denied=true;new Notice('Доступ к совместной заметке закрыт. Локальная копия сохранена.');}else new Notice('Совместная заметка офлайн: локальные правки будут отправлены при восстановлении связи.');}
   if(entry.denied)return entry;
   entry.provider=new HocuspocusProvider({url:this.socketUrl,name:record.id,document:entry.doc,token:()=>this.auth(),onSynced:({state}:any)=>{if(!state)return;entry.ready=true;void this.materialize(entry);this.refresh(record.id);},onAuthenticated:({scope}:any)=>{void this.authenticated(entry,scope);},onAuthenticationFailed:({reason}:any)=>{if(reason==='Service temporarily unavailable'||reason==='Storage paused'){if(reason==='Storage paused')this.storagePaused(entry);entry.provider.disconnect();window.setTimeout(()=>{if(!this.disposed&&!entry.denied)entry.provider.connect();},3000);}else this.deny(entry);},onClose:({event}:any)=>{if(event?.code===4403)this.deny(entry);else if(event?.reason==='Storage paused')this.storagePaused(entry);}});
   entry.provider.setAwarenessField('user',{name:(record.role==='viewer'?'Читатель ':'Участник ')+entry.doc.clientID.toString(16).slice(-4),color:'#'+(entry.doc.clientID%0xffffff).toString(16).padStart(6,'0'),colorLight:'#ddd8ff'});
   entry.text.observe(()=>{void this.materialize(entry);});
   if(entry.text.length||entry.doc.getMap('state').get('initialized')){entry.ready=true;void this.materialize(entry);}
   return entry;})();return entry.promise;}
 async authenticated(e:any,scope:string){
  const generation=e.authorization=(e.authorization||0)+1;
  // Server read-only scope also applies to owners after their Pro expires.
  e.record.role=scope==='read-write'?(e.record.role==='viewer'?'editor':e.record.role):'viewer';
  void this.save();this.refresh(e.record.id);
  if(scope!=='read-write')return;
  try{const access=await this.api('authorize',{id:e.record.id});if(this.disposed||e.denied||e.authorization!==generation)return;e.record.role=access.role;await this.save();this.refresh(e.record.id);}catch{/* The authenticated socket still enforces its current scope. */}
 }
 storagePaused(e:any){e.record.role='viewer';void this.save();this.refresh(e.record.id);if(!(this as any).retentionNotified){(this as any).retentionNotified=true;new Notice('Серверная копия совместных заметок недоступна. Локальные копии сохранены. Подключение возобновится после оплаты Pro.');}}
 deny(e:any){if(e.denied)return;e.denied=true;e.provider?.disconnect();this.refresh(e.record.id);new Notice('Доступ отозван. Локальная копия сохранена; редактирование остановлено.');}
 refresh(id:string){for(const [view,info]of this.views)if(this.records.find(r=>r.path===info.path)?.id===id)window.setTimeout(()=>{void this.attach(view,true);},0);}
 async attach(view:any,force=false){try{const info=this.views.get(view);if(!info||this.disposed)return;const path=this.filePath(view);if(!force&&info.path===path)return;info.path=path;const attachment=info.attachment=(info.attachment||0)+1;const record=this.records.find(r=>r.path===path);
   if(!record){if(info.added)view.dispatch({effects:info.compartment.reconfigure([])});return;}
   // Make the editor read-only while loading; never send the markdown snapshot as CRDT seed.
   view.dispatch({effects:info.added?info.compartment.reconfigure([EditorState.readOnly.of(true),Prec.highest(EditorView.editable.of(false))]):StateEffect.appendConfig.of(info.compartment.of([EditorState.readOnly.of(true),Prec.highest(EditorView.editable.of(false))]))});info.added=true;
   const entry=await this.ensure(record);if(this.disposed||!this.views.has(view)||info.attachment!==attachment||this.filePath(view)!==record.path)return;
   const readonly=entry.denied||record.role==='viewer'||!entry.ready;
   const extensions=entry.denied||!entry.ready?[EditorState.readOnly.of(true),Prec.highest(EditorView.editable.of(false))]:[yCollab(entry.text,entry.provider.awareness,{undoManager:record.role==='viewer'?false:entry.undo}),Prec.highest(keymap.of(yUndoManagerKeymap)),EditorState.readOnly.of(readonly),Prec.highest(EditorView.editable.of(!readonly))];
   // Align the editor while the CRDT binding is detached. Installing yCollab
   // in the same transaction would replay this snapshot as a local Yjs edit.
   if(!entry.denied&&entry.ready&&view.state.doc.toString()!==entry.text.toString())view.dispatch({changes:{from:0,to:view.state.doc.length,insert:entry.text.toString()}});
   view.dispatch({effects:info.compartment.reconfigure(extensions)});
  }catch(e:any){if(!this.disposed)new Notice(e.message);}}
 async materialize(entry:any){if(this.disposed||entry.denied)return;entry.materializing=entry.materializing.catch(()=>{}).then(async()=>{if(this.disposed||entry.denied)return;const text=entry.text.toString(),file=this.app.vault.getAbstractFileByPath(entry.record.path);if(!(file instanceof TFile))return;
   const current=await this.app.vault.read(file);entry.lastDisk=text;entry.diskState=Y.encodeStateAsUpdate(entry.doc);if(current!==text)await this.app.vault.modify(file,text);});await entry.materializing;}
 async external(file:any){const record=this.records.find(r=>r.path===file.path);if(!record)return;const e=await this.ensure(record);if(e.denied||!e.ready)return;await e.materializing;const text=await this.app.vault.read(file),current=e.text.toString();if(text===current||text===e.lastDisk)return;
  if(record.role==='viewer'||[...this.views.keys()].some(v=>this.filePath(v)===file.path)){await this.materialize(e);return;}
  if(e.lastDisk!==null&&e.lastDisk!==current){await this.app.vault.adapter.write(this.plugin.pilotDirectory+'/external-'+record.id+'-'+Date.now()+'.md',text);new Notice('Внешняя правка совпала с удалённой. Сохранена отдельная локальная копия в каталоге плагина.');await this.materialize(e);return;}
  const diff=textChange(current,text);e.doc.transact(()=>{if(diff.remove)e.text.delete(diff.from,diff.remove);if(diff.insert)e.text.insert(diff.from,diff.insert);},'external-file');await this.materialize(e);}
 async rename(file:any,old:string){const record=this.records.find(r=>r.path===old);if(!record)return;if(!reserved(file.path)){await this.app.fileManager.renameFile(file,old);new Notice('Совместные заметки можно перемещать только внутри '+FOLDER);return;}record.path=file.path;await this.save();this.refresh(record.id);}
 dispose(){this.disposed=true;for(const [view,info]of this.views)if(info.added)try{view.dispatch({effects:info.compartment.reconfigure([])});}catch{/* An editor being destroyed needs no binding. */}for(const e of this.entries.values()){e.provider?.destroy();e.persistence?.destroy();e.undo?.destroy();e.doc.destroy();}this.views.clear();}
}
