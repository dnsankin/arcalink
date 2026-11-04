import {Modal,Notice,Setting,TFile} from 'obsidian';
import {localizeMessage} from './localized-obsidian';
import {createLocalBackupStore,backupPath,backupDefaults} from './local-backup-store.mjs';
import {installLocalBackupHooks} from './local-backup-hooks.mjs';
import {createBackupRestorer} from './local-backup-restore.mjs';
import {hashShared2Stream} from './shared2-stream-hash.mjs';
const friendly=(e:any)=>{
 const code=e?.code||e?.message;
 if(code==='backup-file-exceeds-quota'||code==='backup-quota-too-small')return 'Файл не помещается в лимит резервных копий. Увеличьте максимальный объём. Замена или удаление остановлены.';
 if(code==='backup-source-changed'||code==='backup-restore-target-changed')return 'Файл изменился во время операции. Повторите попытку; восстановление не выполнено.';
 if(/corrupt|unreadable|invalid|recovery/.test(String(code)))return 'Резервная копия или её индекс повреждены. Восстановление остановлено; сохранённые данные не удалялись.';
 if(code==='backup-stream-unavailable')return 'Не удалось открыть поток чтения большого файла. Его замена остановлена, поскольку резервная копия не создана.';
 return 'Не удалось сохранить резервную копию. Замена или удаление остановлены; проверьте свободное место и настройки резервирования.';
};
export class LocalBackups {
 store:any;private restorer:any;enabled=false;error='';progress='';private disposed=false;private stop=false;private busy=false;private panels=new Set<HTMLElement>();private raw:any;private disposeHooks?:()=>void;private recoveryError:any=null;private views=new WeakMap<HTMLElement,any>();private refreshTimer=0;private configurationRevision=0;
 constructor(private plugin:any){}
 private accepts(path:string){const config=this.plugin.app.vault.configDir;return backupPath(path)&&path!==config&&!path.startsWith(config+'/')&&path!=='ArcaLink Shared'&&!path.startsWith('ArcaLink Shared/');}
 get root(){return this.plugin.pilotDirectory+'/local-backups-v1';}
 async init(){
  const p=this.plugin,a=p.app.vault.adapter;this.raw={};
  for(const name of ['write','writeBinary','appendBinary','rename','remove','mkdir','stat','list','exists','read','readBinary'])this.raw[name]=a[name].bind(a);
  this.store=createLocalBackupStore({adapter:this.raw,root:this.root,readStream:(path:string)=>this.readStream(path),accept:(path:string)=>this.accepts(path)});
  this.restorer=createBackupRestorer({adapter:this.raw,root:this.root,readStream:(path:string)=>this.readStream(path),accept:(path:string)=>this.accepts(path)});
  try{await this.restorer.recover();this.enabled=(await this.store.state()).settings.enabled;}catch(e){this.recoveryError=e;this.enabled=true;this.error=friendly(e);}
  this.disposeHooks=installLocalBackupHooks({adapter:a,enabled:()=>this.enabled,accept:(path:string)=>this.accepts(path),capture:(path:string,reason:string)=>{if(this.recoveryError)throw this.recoveryError;return this.store.capture(path,reason);},failed:(e:any)=>{this.error=friendly(e);new Notice(this.error,15000);this.redraw();},changed:()=>{}});
  p.register(()=>{this.disposed=true;this.stop=true;window.clearTimeout(this.refreshTimer);this.disposeHooks?.();this.store.dispose();this.panels.clear();});
  p.registerEvent(p.app.vault.on('create',(file:any)=>this.observe(file)));
  p.registerEvent(p.app.vault.on('modify',(file:any)=>this.observe(file)));
  p.registerEvent(p.app.vault.on('rename',(file:any)=>this.observe(file)));
  p.registerInterval(window.setInterval(()=>{if(this.enabled&&!this.busy)void this.store.cleanup().catch((e:any)=>{this.error=friendly(e);this.redraw();});},3600000));
  p.app.workspace.onLayoutReady(()=>{if(this.enabled)void this.snapshot();});
 }
 private async readStream(path:string){
  const stat=await this.raw.stat(path);if(!stat||stat.type!=='file')throw Error('backup-source-missing');
  // The resource endpoint streams local bytes on desktop and mobile. A bounded
  // fallback is allowed only for small files; never read a whole large video.
  try{const response=await fetch(this.plugin.app.vault.adapter.getResourcePath(path),{cache:'no-store'});if(response.ok&&response.body)return response.body;}catch{}
  if(stat.size>8*1024*1024)throw Error('backup-stream-unavailable');
  const data=await this.raw.readBinary(path);return (async function*(){yield new Uint8Array(data);})();
 }
 private observe(file:any){if(this.enabled&&!this.disposed&&file instanceof TFile&&this.accepts(file.path))void this.store.capture(file.path,'saved').catch((e:any)=>{this.error=friendly(e);this.redraw();});}
 async configure(patch:any){if(this.recoveryError)throw this.recoveryError;this.configurationRevision++;if(patch.enabled===false)this.stop=true;const settings=await this.store.configure(patch);this.enabled=settings.enabled;if(!this.enabled)this.stop=true;this.error='';this.redraw();}
 async snapshot(){
  if(this.busy||!this.enabled||this.disposed)return;this.busy=true;this.stop=false;let done=0;
  try{const files=this.plugin.app.vault.getFiles().filter((f:any)=>this.accepts(f.path));
   for(const f of files){if(this.stop||this.disposed)break;this.progress=`Сохранено ${done} из ${files.length}: ${f.path}`;this.redraw();await this.store.capture(f.path,'snapshot');done++;await new Promise(resolve=>window.setTimeout(resolve,0));}
   this.progress=this.stop?`Остановлено. Проверено файлов: ${done}`:`Снимок завершён. Проверено файлов: ${done}`;await this.store.cleanup();this.error='';
  }catch(e){this.error=friendly(e);}finally{this.busy=false;this.redraw();}
 }
 private async ensureParents(path:string){let current='';for(const part of path.split('/').slice(0,-1)){current+=(current?'/':'')+part;if(!await this.raw.exists(current))await this.raw.mkdir(current);}}
 async restore(id:string){
  if(this.busy)throw Error('Дождитесь завершения снимка.');
  const retained=await this.store.retain(id);try{
  const v=retained.version;if(!this.accepts(v.path))throw Error('Недопустимый путь.');
  // Restoring a file must preserve its current state even if background backup
  // was disabled after the selected version was created.
  const before=await this.store.state();this.busy=true;
  try{
   if(!before.settings.enabled)await this.store.configure({enabled:true});
   const previous=await this.store.capture(v.path,'before-restore');
   const expectedHash=previous?.sha256??null;
   await this.ensureParents(v.path);const file=this.plugin.app.vault.getAbstractFileByPath(v.path);
   if(file&&!(file instanceof TFile))throw Error('На этом пути находится папка.');
   if(v.size<=8*1024*1024){
    const bytes=new Uint8Array(v.size);let offset=0;for await(const b of this.store.stream(v)){bytes.set(b,offset);offset+=b.length;}
    if((await this.raw.exists(v.path)?(await hashShared2Stream(await this.readStream(v.path))).sha256:null)!==expectedHash)throw Error('backup-restore-target-changed');
    if(file)await this.plugin.app.vault.modifyBinary(file,bytes.buffer);else await this.plugin.app.vault.createBinary(v.path,bytes.buffer);
   }else await this.restorer.restore(v,this.store.stream(v),{expectedHash});
   if((await hashShared2Stream(await this.readStream(v.path))).sha256!==v.sha256)throw Error('Восстановленный файл не прошёл проверку.');
   this.error='';new Notice('Версия восстановлена. Изменение будет передано обычной синхронизацией.');
  }finally{this.busy=false;if(!before.settings.enabled)await this.store.configure({enabled:false});this.redraw();}
  }finally{await retained.release();}
 }
 private redraw(){if(this.disposed||this.refreshTimer)return;this.refreshTimer=window.setTimeout(()=>{this.refreshTimer=0;for(const el of this.panels){if(!el.isConnected){this.panels.delete(el);continue;}void this.render(el);}},150);}
 private createView(el:HTMLElement){
  el.empty();el.createEl('h3',{text:'Резервные копии'});
  el.createEl('p',{text:'Локальная история на этом устройстве. Копии не отправляются на сервер и хранятся без дополнительного шифрования. Резервирование работает, пока Obsidian открыт; потеря устройства затронет и эти копии.'});
  const view:any={query:'',versionsKey:null,readAt:0};
  new Setting(el).setName('Включить резервирование').setDesc('Сохранять предыдущую версию перед заменой, удалением и входящими изменениями синхронизации.').addToggle(t=>{view.toggle=t;t.setValue(this.enabled).onChange(async value=>{try{await this.configure({enabled:value});if(value)void this.snapshot();}catch(e){this.error=friendly(e);this.redraw();}});});
  new Setting(el).setName('Срок хранения, дней').addText(t=>{view.days=t;t.setValue(String(backupDefaults.days)).setDisabled(true);t.inputEl.type='number';t.inputEl.min='1';t.inputEl.max='365';t.inputEl.addEventListener('change',()=>{const value=t.inputEl.value;if(/^\d+$/.test(value)&&+value>=1&&+value<=365)void this.configure({days:+value}).catch(e=>{this.error=friendly(e);this.redraw();});});});
  new Setting(el).setName('Максимальный объём, МиБ').setDesc('При заполнении удаляются старейшие версии. Файл больше лимита нельзя защитить: его замена будет остановлена.').addText(t=>{view.limit=t;t.setValue(String(backupDefaults.maxBytes/1048576)).setDisabled(true);t.inputEl.type='number';t.inputEl.min='1';t.inputEl.addEventListener('change',()=>{const value=t.inputEl.value;if(/^\d+$/.test(value)&&+value>=1)void this.configure({maxBytes:+value*1048576}).catch(e=>{this.error=friendly(e);this.redraw();});});});
  view.stats=el.createEl('p',{text:'Загрузка истории…'});
  new Setting(el).setName('Снимок текущих файлов').addButton(b=>{view.start=b;b.setButtonText('Создать снимок').onClick(()=>void this.snapshot());}).addButton(b=>{view.stop=b;b.setButtonText('Остановить').onClick(()=>{this.stop=true;this.updateProgress(view);});});
  view.progress=el.createEl('p');view.error=el.createEl('p',{cls:'mod-warning'});
  new Setting(el).setName('Поиск по пути файла').addText(t=>{view.search=t;t.setPlaceholder('Часть пути').onChange((query:string)=>{view.query=query;view.draw();});});
  const list=el.createDiv();
  view.draw=()=>{if(!view.state)return;list.empty();const versions=[...view.state.versions].reverse().filter((v:any)=>v.path.toLowerCase().includes(view.query.toLowerCase()));
    for(const v of versions.slice(0,100))new Setting(list).setName(v.path).setDesc(`${new Date(v.time).toLocaleString()} · ${(v.size/1024).toFixed(1)} КиБ`).addButton(b=>b.setButtonText('Сравнить / восстановить').onClick(async()=>{b.setDisabled(true);try{await this.openVersion(v);}catch(e){new Notice(friendly(e),15000);}finally{b.setDisabled(false);}}));
    if(versions.length>100)list.createEl('p',{text:'Показаны первые 100 версий. Уточните путь.'});if(!versions.length)list.createEl('p',{text:'Сохранённых версий нет.'});};
  return view;
 }
 private updateProgress(view:any){
  if(view.progress.textContent!==this.progress)view.progress.setText(this.progress);
  if(view.error.textContent!==this.error)view.error.setText(this.error);
  view.progress.hidden=!this.progress;view.error.hidden=!this.error;
  view.start.setDisabled(!this.enabled||this.busy);view.stop.buttonEl.hidden=!this.busy;
  view.stop.setDisabled(this.stop).setButtonText(this.stop?'Останавливается…':'Остановить');
 }
 async render(el:HTMLElement){
  if(this.disposed)return;
  this.panels.add(el);let view=this.views.get(el);
  if(!view){view=this.createView(el);this.views.set(el,view);}
  // Progress must not wait behind a large capture or replace focused controls.
  this.updateProgress(view);
  if(view.loading)return view.loading;
  if(this.busy&&view.state&&Date.now()-view.readAt<1000)return;
  view.readAt=Date.now();const revision=this.configurationRevision;
  view.loading=(async()=>{try{
   const state=await this.store.state({priority:true});if(this.disposed||this.views.get(el)!==view)return;if(revision!==this.configurationRevision){this.redraw();return;}
   view.state=state;
   if(view.toggle.getValue()!==state.settings.enabled)view.toggle.setValue(state.settings.enabled);
   view.toggle.setDisabled(false);
   for(const [input,value]of [[view.days,String(state.settings.days)],[view.limit,String(state.settings.maxBytes/1048576)]] as const){input.setDisabled(false);if(el.ownerDocument.activeElement!==input.inputEl&&input.getValue()!==value)input.setValue(value);}
   view.stats.setText(`Версий: ${state.versions.length}. Занято: ${(state.usedBytes/1048576).toFixed(1)} МиБ.`);
   const key=state.versions.map((v:any)=>v.id).join(',');if(key!==view.versionsKey){view.versionsKey=key;view.draw();}
  }catch(e){this.error=friendly(e);}finally{view.loading=undefined;if(!this.disposed)this.updateProgress(view);}})();
  return view.loading;
 }
 private async comparisonText(path:string){
  const large=localizeMessage('Текущий файл больше 1 МиБ. Текстовое сравнение недоступно; восстановление доступно.');
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const stat=await this.raw.stat(path);if(!stat)return localizeMessage('Файл отсутствует');
   if(stat.type!=='file'||!Number.isSafeInteger(stat.size)||stat.size<0)return localizeMessage('Не удалось прочитать текущий файл для сравнения.');
   if(stat.size>1024*1024)return large;
   const response=await fetch(this.plugin.app.vault.adapter.getResourcePath(path),{cache:'no-store'});
   if(!response.ok||!response.body)return localizeMessage('Не удалось прочитать текущий файл для сравнения.');
   reader=response.body.getReader();const decoder=new TextDecoder();let text='',size=0;
   for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024)return large;text+=decoder.decode(part.value,{stream:true});}
   return text+decoder.decode();
  }catch{return localizeMessage('Не удалось прочитать текущий файл для сравнения.');}
  finally{if(reader){try{await reader.cancel();}catch{}reader.releaseLock();}}
 }
 private async openVersion(v:any){
  const retained=await this.store.retain(v.id,{priority:true});try{v=retained.version;const modal=new Modal(this.plugin.app);modal.titleEl.setText(v.path);modal.contentEl.createEl('p',{text:`Версия от ${new Date(v.time).toLocaleString()}. При восстановлении текущее содержимое будет сохранено в истории. Изменение может синхронизироваться с другими устройствами.`});
  if(v.size<=1024*1024&&/\.(md|txt|json|csv|css|js|html|xml)$/i.test(v.path)){
   const parts=[];for await(const p of this.store.stream(v))parts.push(p);const old=await new Blob(parts).text();const current=await this.comparisonText(v.path);
   modal.modalEl.addClass('arcalink-backup-compare-modal');
   const headings=modal.contentEl.createDiv({cls:'arcalink-backup-compare-headings'});
   for(const title of ['Сохранённая версия','Текущий файл'])headings.createEl('h4',{text:title});
   // Both columns share one scroll viewport, including keyboard/touch scrolling.
   const viewport=modal.contentEl.createDiv({cls:'arcalink-backup-compare-scroll',attr:{tabindex:'0',role:'region','aria-label':'Сравнение версий'}});
   const columns=viewport.createDiv({cls:'arcalink-backup-compare-columns'});
   for(const [title,text]of [['Сохранённая версия',old],['Текущий файл',current]])columns.createEl('pre',{text,attr:{'data-arcalink-user-content':'true','aria-label':title}});
  }
  new Setting(modal.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>modal.close())).addButton(b=>b.setButtonText('Подтверждаю восстановление').setCta().onClick(async()=>{b.setDisabled(true);try{await this.restore(v.id);modal.close();}catch(e){new Notice(friendly(e),15000);b.setDisabled(false);}}));modal.open();
  }finally{await retained.release();}
 }
}
