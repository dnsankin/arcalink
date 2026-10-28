import {Modal,Notice,Platform,Setting} from 'obsidian';
import {requestUrl} from './localized-obsidian';
import {ASSISTANT_SITE,ASSISTANT_CATALOG,validateAssistantRelease,boundedOfficialGet,verifyAssistantApk} from './assistant-download.mjs';
import {sha256,safeCompanionPath} from './companion-proof.mjs';

const deliveryLabel=(state:string)=>({preparing:'Подготовка установщика',downloading:'Загрузка и проверка установщика',committing:'Добавление в обменник',waiting:'Ожидает синхронизации со смартфоном',received:'Файл передан на выбранный смартфон','exchange-ready':'APK добавлен в обменник',cancelled:'Получение остановлено',error:'Ошибка получения установщика'} as Record<string,string>)[state]||'APK ещё не добавлен в обменник';
export class MobileAssistant {
 private disposed=false;private busy=false;private polling=false;private controller:AbortController|null=null;
 private last:any=null;private release:any=null;private state='';private message='';private views=new Set<HTMLElement>();
 private journalWrites:Promise<void>=Promise.resolve();private installerWrites:Promise<void>=Promise.resolve();
 private attempt:{cancelled:boolean;committed:boolean;controller:AbortController;record:any}|null=null;
 constructor(private plugin:any){}
 private get journal(){return this.plugin.pilotDirectory+'/assistant-delivery.json';}
 async init(){try{this.last=JSON.parse(await this.plugin.app.vault.adapter.read(this.journal));this.state=this.last?.delivery?.state||'';}catch{/* Optional feature has no journal on first use. */}}
 dispose(){this.disposed=true;this.controller?.abort();this.views.clear();}
 private async scope(){return await this.plugin.folderPolicies.bindingId();}
 private async api(action:string,body:any={},workspace?:string){
  const p=this.plugin;let {auth,session}=await p.folderPolicies.credentialsAuth();const id=workspace||await this.scope();
  if(!/^[a-f0-9]{32}$/.test(id||''))throw Error('Сначала подключите хранилище ArcaLink.');
  const send=()=>requestUrl({url:p.unifiedVault.base+'/companion/'+action,method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({workspace:id,...body}),throw:false});
  let response=await send();
  if(response.status===401&&session?.refreshToken){session=await p.freeRelay.refresh({...session,group:session.group||id});auth='Bearer '+session.accessToken;response=await send();}
  let payload:any;try{payload=response.json;}catch{throw Error('Получение Android-помощника временно недоступно. Повторите позже.');}
  if(response.status!==200)throw Error(payload?.message||payload?.error||'Получение Android-помощника временно недоступно. Повторите позже.');
  return payload;
 }
 private refresh(){for(const el of this.views){if(!el.isConnected){this.views.delete(el);continue;}this.fill(el);}}
 render(el:HTMLElement){this.views.add(el);this.fill(el);}
 private fill(el:HTMLElement){
  el.empty();new Setting(el).setName('Мобильный помощник').setHeading();
  el.createEl('p',{text:'Заметки и список дел на рабочем столе Android. Быстрые записи, фото, голос и обмен файлами.'});
  if(this.release){
   el.createEl('p',{text:`Версия ${this.release.version} · ${new Date(this.release.releasedAt).toLocaleDateString()} · ${(this.release.size/1048576).toFixed(1)} МиБ`});
   const changes=el.createEl('details');changes.createEl('summary',{text:'Что нового'});changes.createEl('p',{text:this.release.changes});
  }
  new Setting(el).addButton(b=>b.setButtonText('Получить свежий ассистент').setDisabled(this.busy).onClick(()=>void this.prepare()));
  const site=el.createEl('a',{text:'Скачать с сайта ArcaLink',href:ASSISTANT_SITE,attr:{target:'_blank',rel:'noopener noreferrer'}});
  site.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();window.open(ASSISTANT_SITE,'_blank','noopener,noreferrer');});
  el.createEl('p',{text:deliveryLabel(this.state)+(this.message?' · '+this.message:'')});
  if(this.last?.delivery){
   if(this.last.kind==='exchange'){
    el.createEl('p',{text:`Версия ${this.last.delivery.version} · ${this.last.delivery.path}`});
    if(this.state==='exchange-ready')el.createEl('p',{text:'APK появится на устройствах, синхронизирующих эту папку. На Android откройте файл и подтвердите установку.'});
    if(!['exchange-ready','cancelled'].includes(this.state))new Setting(el).addButton(b=>b.setButtonText('Отменить загрузку').onClick(()=>void this.cancel()));
    if(['error','preparing'].includes(this.state))new Setting(el).addButton(b=>b.setButtonText('Повторить получение').setDisabled(this.busy).onClick(()=>void this.resume()));
    return;
   }
   el.createEl('p',{text:`Версия ${this.last.delivery.version} · ${this.last.targetName||'Выбранный смартфон'} · ${this.last.delivery.path}`});
   new Setting(el).addButton(b=>b.setButtonText('Проверить передачу').onClick(()=>void this.poll().catch(e=>{this.message=e.message;this.refresh();})));
   if(!this.last.readOnly&&!['received','cancelled'].includes(this.state))new Setting(el).addButton(b=>b.setButtonText(this.state==='preparing'||this.state==='downloading'?'Отменить получение':'Прекратить ожидание подтверждения').onClick(()=>void this.cancel()));
   if(!this.last.readOnly&&(this.state==='error'||this.state==='preparing'))new Setting(el).addButton(b=>b.setButtonText('Повторить получение').setDisabled(this.busy).onClick(()=>void this.resume()));
   if(this.state==='received'){
    el.createEl('p',{text:'Откройте на смартфоне папку «Обмен», выберите APK и подтвердите установку в Android. Передача файла не означает установку приложения.'});
    new Setting(el).addButton(b=>b.setButtonText('Повторить доставку этой версии').setDisabled(this.busy).onClick(()=>{
     const previous=this.last;new AssistantConfirmation(this.plugin.app,this,[{id:previous.delivery.target,name:previous.targetName,online:false}],previous.release,previous.workspace,true).open();
    }));
   }
  }
 }
 private async prepare(){
  if(this.busy)return;this.busy=true;this.message='Проверяем опубликованную версию';this.refresh();
  try{
   this.controller=new AbortController();const timer=window.setTimeout(()=>this.controller?.abort(),20000);
   try{this.release=validateAssistantRelease(JSON.parse(new TextDecoder().decode(await boundedOfficialGet(ASSISTANT_CATALOG,16384,{signal:this.controller.signal}))));}
   finally{window.clearTimeout(timer);}
   if(this.disposed)return;
   const workspace=await this.scope();
   if(!/^[a-f0-9]{32}$/.test(workspace||''))throw Error('Сначала подключите хранилище ArcaLink, чтобы добавить APK в синхронизируемую папку.');
   if(this.disposed)return;
   this.message='';new AssistantExchangeConfirmation(this.plugin.app,this,this.release,workspace).open();
  }catch(e:any){this.message=e.name==='AbortError'?'Получение отменено или сервер не ответил вовремя':e.message;}
  finally{this.busy=false;this.controller=null;this.refresh();}
 }
 private async checkExchangePath(path:string,size:number){
  if(!safeCompanionPath(path))throw Error('Некорректный путь установщика в обменнике.');
  if(this.plugin.folderPolicies.excludes(path)||this.plugin.folders.contains(path))throw Error('Папка обмена исключена из обычной синхронизации. Выберите синхронизируемую папку.');
  if(!await this.plugin.core.services.vault.isTargetFile(path))throw Error('APK исключён текущими правилами синхронизации файлов. Измените правила перед передачей.');
  if(this.plugin.core.services.vault.isFileSizeTooLarge(size))throw Error('APK превышает настроенный лимит размера синхронизируемого файла.');
 }
 async start(target:any,release:any,workspace:string,retry=false){
  if(this.busy)return;this.busy=true;this.state='preparing';this.message='';this.refresh();
  const attempt={cancelled:false,committed:false,controller:new AbortController(),record:null as any};this.attempt=attempt;this.controller=attempt.controller;
  try{
   if(!/^[a-f0-9]{32}$/.test(workspace||'')||workspace!==await this.scope())throw Error('Хранилище изменилось. Повторите получение установщика.');
   const folder=this.plugin.desktop.settings.exchangeFolder;
   if(!safeCompanionPath(folder))throw Error('Настройте папку обменника.');
   const path=folder+'/ArcaLink Android/'+release.version+'/'+(retry?'Повтор-'+crypto.randomUUID().slice(0,8)+'/':'')+release.filename;
   await this.checkExchangePath(path,release.size);
   const created=target?await this.api('create',{target:target.id,path,version:release.version,sha256:release.sha256,retry},workspace):{delivery:{id:crypto.randomUUID().replace(/-/g,''),path,version:release.version,state:'preparing'},existing:false};
   attempt.record={workspace,release,...(target?{targetName:target.name}:{kind:'exchange'}),delivery:created.delivery};
   if(attempt.cancelled||this.disposed){if(target)await this.api('cancel',{id:created.delivery.id},workspace);this.state='cancelled';return;}
   this.last=attempt.record;await this.save();
   if(target){
    const session=await this.plugin.workspaces.session();
    if(created.existing&&created.delivery.sender!==session.deviceId){this.last.readOnly=true;await this.save();this.state=created.delivery.state;this.message='Эта передача уже запрошена на другом устройстве. Управляйте ею с устройства отправителя.';return;}
    if(created.existing&&['waiting','received'].includes(created.delivery.state)){
     this.state=created.delivery.state;this.message='Такая версия уже передана в обменник. Используйте текущий файл или явно запросите повторную доставку.';return;
    }
   }
   await this.download(attempt,attempt.record);
  }catch(e:any){if(!attempt.cancelled){this.state='error';this.message=e.message;}}
  finally{this.busy=false;if(this.attempt===attempt){this.attempt=null;this.controller=null;}this.refresh();}
 }
 private save(){
  const snapshot=JSON.stringify(this.last),write=this.journalWrites.catch(()=>{}).then(()=>this.plugin.app.vault.adapter.write(this.journal,snapshot));
  this.journalWrites=write;return write;
 }
 private async download(attempt:any,record:any){
  if(attempt.cancelled||record.delivery.state==='cancelled')return;
  const p=this.plugin,delivery=record.delivery,adapter=p.app.vault.adapter,release=validateAssistantRelease(record.release);
  if(!safeCompanionPath(delivery.path)||delivery.path.split('/').pop()!==release.filename)throw Error('Некорректный путь установщика в обменнике.');
  if(record.kind==='exchange')await this.checkExchangePath(delivery.path,release.size);
  const workspace=record.workspace;this.state='downloading';this.refresh();
  const timer=window.setTimeout(()=>attempt.controller.abort(),120000);
  const current=async()=>{
   if(this.disposed||attempt.cancelled||attempt.controller.signal.aborted)return false;
   const scope=await this.scope();
   return !this.disposed&&!attempt.cancelled&&!attempt.controller.signal.aborted&&workspace===scope;
  };
  const stage=p.pilotDirectory+'/assistant-'+delivery.id+'.apk.part';
  try{
   const bytes=await boundedOfficialGet(release.url,release.size,{signal:attempt.controller.signal});await verifyAssistantApk(release,bytes);
   if(!await current())throw Error('Получение отменено или хранилище изменилось.');
   this.state='committing';this.refresh();
   if(await adapter.exists(delivery.path)){
    const existing=await adapter.readBinary(delivery.path);
    if(existing.byteLength!==release.size||await sha256(existing)!==release.sha256)throw Error('В обменнике уже есть другой файл с таким именем. Переместите его и повторите получение.');
   }else{
    // This directory is excluded from both ordinary and internal-file replication.
    await adapter.writeBinary(stage,bytes);await verifyAssistantApk(release,await adapter.readBinary(stage));
    let folder='';for(const part of delivery.path.split('/').slice(0,-1)){folder=folder?folder+'/'+part:part;if(!await adapter.exists(folder))await p.app.vault.createFolder(folder);}
    if(!await current())throw Error('Получение отменено.');
    if(record.kind==='exchange'){
     await this.checkExchangePath(delivery.path,release.size);
     if(!await current())throw Error('Получение отменено или хранилище изменилось.');
    }
    attempt.committed=true;await p.app.vault.createBinary(delivery.path,bytes);
   }
   await verifyAssistantApk(release,await adapter.readBinary(delivery.path));
   if(!await current())throw Error('Файл подготовлен, но ожидание подтверждения прекращено. Он может появиться на устройствах, синхронизирующих обменник.');
   if(record.kind==='exchange'){
    if(Platform.isAndroidApp)await this.rememberInstaller({...delivery,size:release.size,sha256:release.sha256});
    if(!await current()||record.delivery.state==='cancelled')throw Error('Получение остановлено. Уже сохранённый APK остаётся в обменнике.');
    record.delivery.state='exchange-ready';this.state='exchange-ready';this.message='';await this.save();
   }else{
    const result=await this.api('ready',{id:delivery.id},workspace);record.delivery=result.delivery;this.state=result.delivery.state;await this.save();
   }
  }finally{window.clearTimeout(timer);if(await adapter.exists(stage))await adapter.remove(stage);}
 }
 private async resume(){
  if(this.busy||!this.last)return;
  if(this.last.kind!=='exchange'&&(this.last.readOnly||(await this.plugin.workspaces.session()).deviceId!==this.last.delivery.sender)){this.message='Передачей управляет другое устройство отправителя.';this.refresh();return;}
  if(this.last.delivery.state==='cancelled'){this.state='cancelled';this.message='Запросите свежий ассистент заново.';this.refresh();return;}
  this.busy=true;
  const attempt={cancelled:false,committed:false,controller:new AbortController(),record:this.last};this.attempt=attempt;this.controller=attempt.controller;
  try{if(this.last.delivery.state==='cancelled')throw Error('Передача отменена. Запросите свежий ассистент заново.');if(this.last.workspace!==await this.scope())throw Error('Выберите исходное хранилище передачи.');await this.download(attempt,this.last);}
  catch(e:any){if(!attempt.cancelled){this.state='error';this.message=e.message;}}finally{this.busy=false;this.attempt=null;this.controller=null;this.refresh();}
 }
 private async cancel(){
  const attempt=this.attempt;if(attempt){attempt.cancelled=true;attempt.controller.abort();}
  const record=attempt?attempt.record:this.last;
  try{
   if(record?.kind==='exchange'){
    record.delivery.state='cancelled';this.last=record;this.state='cancelled';await this.save();
   }else if(record){
    if(record.readOnly||(await this.plugin.workspaces.session()).deviceId!==record.delivery.sender)throw Error('Передачей управляет другое устройство отправителя.');
    const result=await this.api('cancel',{id:record.delivery.id},record.workspace);record.delivery=result.delivery;this.last=record;await this.save();this.state=result.delivery.state;
   }else this.state='cancelled';
   this.message=record?.kind==='exchange'?'Загрузка остановлена. Уже сохранённый APK остаётся в обменнике.':this.state==='received'?'Файл уже получен смартфоном.':'Ожидание прекращено. Уже помещённый в обменник файл может ещё появиться на смартфоне.';
  }catch(e:any){this.message=(record?.kind==='exchange'?'Загрузка остановлена, но не удалось сохранить её состояние: ':'Загрузка остановлена, но не удалось подтвердить отмену на сервере: ')+e.message;}
  this.refresh();
 }
 private rememberInstaller(delivery:any){
  const write=this.installerWrites.catch(()=>{}).then(async()=>{
   const p=this.plugin,folder=p.pilotDirectory+'/companion',path=folder+'/installers.json';
   let records:any[]=[];try{records=JSON.parse(await p.app.vault.adapter.read(path)).installers||[];}catch{}
   records=records.filter(item=>item.path!==delivery.path);records.unshift({path:delivery.path,size:delivery.size,sha256:delivery.sha256,version:delivery.version,verifiedAt:Date.now()});
   if(!await p.app.vault.adapter.exists(folder))await p.app.vault.createFolder(folder);
   await p.app.vault.adapter.write(path,JSON.stringify({schema:1,installers:records.slice(0,50)}));
  });
  this.installerWrites=write;return write;
 }
 async poll(){
  if(this.disposed||this.polling)return;this.polling=true;
  try{
   const p=this.plugin,workspace=await this.scope();if(!workspace||!navigator.onLine)return;
   if(Platform.isAndroidApp){
    const name=p.core.services.setting.currentSettings().P2P_DevicePeerName||p.app.vault.getName()+' · Android';
    await this.api('heartbeat',{platform:'android',name},workspace);
    const inbox=await this.api('inbox',{},workspace);
    for(const delivery of inbox.deliveries||[]){
     if(!safeCompanionPath(delivery.path)||delivery.size>64*1024*1024)continue;
     if(p.folderPolicies.excludes(delivery.path)||!await p.core.services.vault.isTargetFile(delivery.path)){
      await this.api('problem',{id:delivery.id,nonce:delivery.nonce,path:delivery.path,reason:'excluded'},workspace);continue;
     }
     if(p.core.services.vault.isFileSizeTooLarge(delivery.size)){
      await this.api('problem',{id:delivery.id,nonce:delivery.nonce,path:delivery.path,reason:'too-large'},workspace);continue;
     }
     const file=p.app.vault.getAbstractFileByPath(delivery.path);if(!file||file.stat?.size!==delivery.size)continue;
     const bytes=await p.app.vault.readBinary(file);
     if(this.disposed||workspace!==await this.scope()||bytes.byteLength!==delivery.size||await sha256(bytes)!==delivery.sha256)continue;
     await this.rememberInstaller(delivery);
     await this.api('receipt',{id:delivery.id,nonce:delivery.nonce,sha256:delivery.sha256,size:delivery.size,path:delivery.path},workspace);
    }
   }
   if(this.last?.workspace===workspace&&this.last.kind!=='exchange'){
    const result=await this.api('list',{},workspace),delivery=result.deliveries?.find((item:any)=>item.id===this.last.delivery.id);
    if(delivery){this.last.delivery=delivery;this.state=delivery.state;
     this.message=delivery.problem==='excluded'?'На смартфоне APK исключён правилами синхронизации.':delivery.problem==='too-large'?'На смартфоне установлен меньший лимит размера файлов.':this.message;
     await this.save();this.refresh();}
   }
  }finally{this.polling=false;}
 }
}
class AssistantExchangeConfirmation extends Modal {
 constructor(app:any,private owner:MobileAssistant,private release:any,private workspace:string){super(app);}
 override onOpen(){
  this.titleEl.setText('Добавить помощник в обменник');
  this.contentEl.createEl('p',{text:`Android-помощник ${this.release.version} · ${(this.release.size/1048576).toFixed(1)} МиБ`});
  this.contentEl.createEl('p',{text:'APK будет добавлен в синхронизируемую папку обмена. На других устройствах он появится после синхронизации этой папки.'});
  this.contentEl.createEl('p',{text:'На Android откройте APK и подтвердите установку.'});
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Добавить в обменник').setCta().onClick(()=>{this.close();void this.owner.start(null,this.release,this.workspace);}));
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>this.close()));
 }
}
class AssistantConfirmation extends Modal {
 private target:string;
 constructor(app:any,private owner:MobileAssistant,private devices:any[],private release:any,private workspace:string,private retry=false){super(app);this.target=devices[0].id;}
 override onOpen(){
  this.titleEl.setText('Передать Android-помощник');
  this.contentEl.createEl('p',{text:`Arcalinc Sync — Android-помощник ${this.release.version}. Установка выполняется вручную на телефоне средствами Android.`});
  this.contentEl.createEl('p',{text:'APK попадёт в общий Обмен на устройствах, синхронизирующих эту папку; получение проверим на выбранном смартфоне.'});
  new Setting(this.contentEl).setName('Android-смартфон').addDropdown(d=>{for(const item of this.devices)d.addOption(item.id,item.name+(item.online?'':' · вне сети'));d.setValue(this.target).onChange(value=>this.target=value);});
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Передать в обменник').setCta().onClick(()=>{this.close();void this.owner.start(this.devices.find(item=>item.id===this.target),this.release,this.workspace,this.retry);}));
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>this.close()));
 }
}
