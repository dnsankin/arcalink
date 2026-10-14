import {Notice, Platform, Setting, setIcon} from 'obsidian';
import {localizeMessage} from './localized-obsidian';
import {safeRelative} from './folder-model.mjs';
import {trayImage, trayWhiteImage} from './tray-images';

// Electron is optional: Obsidian mobile and builds without remote stay usable.
export function desktopRuntime() {
  try {
    const load=(window as any).require;
    if(!load)return null;
    const electron=load('electron');
    let remote=electron.remote;
    if(!remote){try{remote=load('@electron/remote');}catch{/* Optional compatibility bridge. */}}
    return {window:remote?.getCurrentWindow?.(),app:remote?.app||electron.app,shell:electron.shell||remote?.shell,
      Tray:remote?.Tray||electron.Tray,Menu:remote?.Menu||electron.Menu,
      nativeImage:remote?.nativeImage||electron.nativeImage,globalShortcut:remote?.globalShortcut||electron.globalShortcut};
  }catch{return null;}
}
export function desktopDefaults(mac=Platform.isMacOS) {
  return {tray:false,closeToTray:false,globalHotkeys:false,hideDock:false,
    showHideHotkey:mac?'Command+Option+O':'Ctrl+Shift+Tab',
    quickNoteHotkey:mac?'Command+Option+Q':'Ctrl+Shift+Q',quickNoteFolder:'Быстрые заметки',exchangeFolder:'Exchange'};
}
export function normalizeDesktopSettings(input:any,mac=Platform.isMacOS) {
  const defaults=desktopDefaults(mac),settings={...defaults};
  for(const key of ['tray','closeToTray','globalHotkeys','hideDock'] as const)if(typeof input?.[key]==='boolean')settings[key]=input[key];
  for(const key of ['showHideHotkey','quickNoteHotkey'] as const)if(typeof input?.[key]==='string')settings[key]=input[key].replace(/\s+/g,'').slice(0,120);
  if(typeof input?.quickNoteFolder==='string'&&(input.quickNoteFolder===''||safeRelative(input.quickNoteFolder)))settings.quickNoteFolder=input.quickNoteFolder;
  if(typeof input?.exchangeFolder==='string'&&safeRelative(input.exchangeFolder))settings.exchangeFolder=input.exchangeFolder;
  return settings;
}
// Keep shortcuts responsive inside Obsidian too: some input methods deliver
// window key events without going through the OS global-shortcut hook.
export function matchesDesktopShortcut(accelerator:string,event:any,mac=Platform.isMacOS){
  const parts=accelerator.toLowerCase().split('+'),key=parts.pop();
  const flags={ctrl:false,alt:false,meta:false,shift:false};
  for(const part of parts){
    if(['ctrl','control'].includes(part))flags.ctrl=true;
    else if(['alt','option'].includes(part))flags.alt=true;
    else if(['cmd','command','meta','super'].includes(part))flags.meta=true;
    else if(['mod','commandorcontrol','cmdorctrl'].includes(part))flags[mac?'meta':'ctrl']=true;
    else if(part==='shift')flags.shift=true;
    else return false;
  }
  if(flags.ctrl!==!!event.ctrlKey||flags.alt!==!!event.altKey||flags.meta!==!!event.metaKey||flags.shift!==!!event.shiftKey)return false;
  const aliases:Record<string,string>={up:'arrowup',down:'arrowdown',left:'arrowleft',right:'arrowright',esc:'escape',return:'enter',space:' '};
  const physical=String(event.code||'').match(/^(?:Key|Digit)([A-Z0-9])$/);
  return (aliases[key!]||key)===(physical?physical[1].toLowerCase():String(event.key).toLowerCase());
}
export class DesktopControls {
  settings=desktopDefaults();
  runtime:any;
  tray:any;
  statusBarButton:any;
  shortcuts=new Set<string>();
  shortcutCallbacks=new Map<string,()=>void>();
  lastActivation=new Map<string,number>();
  cleanups:Array<()=>void>=[];
  errors:string[]=[];
  disposed=false;
  quitting=false;
  dockHidden=false;
  noteQueue:Promise<any>=Promise.resolve();
  saveQueue:Promise<any>=Promise.resolve();
  constructor(public plugin:any,private resolveRuntime=desktopRuntime){}
  get path(){return this.plugin.pilotDirectory+'/desktop-settings.json';}
  async init(){
    let saved:any;
    try{saved=JSON.parse(await this.plugin.app.vault.adapter.read(this.path));this.settings=normalizeDesktopSettings(saved);}catch{/* Defaults cover a fresh or damaged optional settings file. */}
    if(!safeRelative(saved?.exchangeFolder))try{
      const legacy=JSON.parse(await this.plugin.app.vault.adapter.read(this.plugin.pilotDirectory+'/data.json'));
      if(safeRelative(legacy?.exchangeFolderPath))this.settings.exchangeFolder=legacy.exchangeFolderPath;
    }catch{/* Old plugin settings may no longer exist. */}
    if(this.disposed||Platform.isMobileApp)return;
    this.plugin.addCommand({id:'desktop-show-hide',name:'Показать или скрыть окно',callback:()=>this.toggle()});
    this.plugin.addCommand({id:'desktop-quick-note',name:'Создать быструю заметку',callback:()=>void this.quickNote()});
    const button=this.plugin.addStatusBarItem?.();
    if(button){
      this.statusBarButton=button;
      button.setAttribute('role','button');button.tabIndex=0;setIcon(button,'folder-open');
      const open=(event:any)=>{event.preventDefault();event.stopPropagation();void this.openExchangeFolder();};
      button.addEventListener('click',open);
      button.addEventListener('keydown',(event:any)=>{if(event.key==='Enter'||event.key===' '||event.key==='Spacebar')open(event);});
      this.updateExchangeButton();
    }
    this.apply();
  }
  updateExchangeButton(){
    if(!this.statusBarButton)return;
    const label=localizeMessage('Открыть папку обменника: '+this.settings.exchangeFolder);
    this.statusBarButton.setAttribute('aria-label',label);
    this.statusBarButton.setAttribute('title',label);
  }
  listen(target:any,event:string,callback:(...args:any[])=>void){
    if(!target?.on)return false;
    try{target.on(event,callback);this.cleanups.push(()=>target.removeListener?.(event,callback));return true;}catch{return false;}
  }
  availableWindow(){try{return !!this.runtime?.window&&!this.runtime.window.isDestroyed?.();}catch{return false;}}
  recovery(){return !!this.tray||(this.settings.globalHotkeys&&this.shortcuts.has(this.settings.showHideHotkey));}
  release(){
    for(const cleanup of this.cleanups.splice(0)){try{cleanup();}catch{/* Continue releasing remaining resources. */}}
    for(const key of this.shortcuts){try{this.runtime?.globalShortcut?.unregister(key);}catch{/* Continue releasing remaining shortcuts. */}}
    this.shortcuts.clear();this.shortcutCallbacks.clear();
    try{this.tray?.destroy();}catch{/* The native object may already be gone. */}this.tray=null;
    if(this.dockHidden){try{this.runtime?.app?.dock?.show?.();}catch{/* Restore the Dock when available. */}this.dockHidden=false;}
  }
  apply(){
    this.release();this.errors=[];
    this.updateExchangeButton();
    if(this.disposed||Platform.isMobileApp)return;
    this.runtime=this.resolveRuntime();
    if(!this.availableWindow()){
      this.errors.push('Управление окном недоступно в этой сборке Obsidian.');return;
    }
    this.quitting=false;
    if(this.settings.tray){
      try{
        const {Tray,Menu,nativeImage}=this.runtime;
        if(!Tray||!Menu||!nativeImage)throw Error();
        let image=nativeImage.createFromDataURL(Platform.isMacOS?trayWhiteImage:trayImage);
        if(image.isEmpty())throw Error();
        image=image.resize({width:Platform.isMacOS?18:16,height:Platform.isMacOS?18:16});
        this.tray=new Tray(image);
        this.tray.setToolTip('ArcaLink · '+this.plugin.app.vault.getName());
        const t=localizeMessage;
        this.tray.setContextMenu(Menu.buildFromTemplate([
          {label:t('Показать или скрыть окно'),click:()=>this.toggle()},
          {label:t('Создать быструю заметку'),click:()=>void this.quickNote()},
          {label:t('Синхронизировать сейчас'),click:()=>void this.plugin.core.services.replication.replicateUserInitiated()},
          {label:t('Открыть папку обменника'),click:()=>void this.openExchangeFolder()},
          {type:'separator'},
          {label:t('Настройки ArcaLink'),click:()=>{this.show();this.plugin.openDesktopSettings();}},
          {label:t('Закрыть это хранилище'),click:()=>{this.quitting=true;this.runtime.window.close();}},
          {label:t('Выйти из приложения'),click:()=>{this.quitting=true;this.runtime.app.quit();}}
        ]));
        if(!Platform.isMacOS)this.tray.on('click',()=>this.toggle());
      }catch{try{this.tray?.destroy();}catch{/* Ignore cleanup of a partially created tray. */}this.tray=null;this.errors.push('Не удалось создать значок в трее.');}
    }
    if(this.settings.globalHotkeys){
      for(const [key,callback] of [[this.settings.showHideHotkey,()=>this.toggle()],[this.settings.quickNoteHotkey,()=>void this.quickNote()]] as const){
        if(!key)continue;
        try{
          const action=()=>{const now=Date.now();if(now-(this.lastActivation.get(key)||0)<150)return;this.lastActivation.set(key,now);callback();};
          if(this.shortcuts.has(key)||!this.runtime.globalShortcut?.register(key,action))throw Error();
          this.shortcuts.add(key);this.shortcutCallbacks.set(key,action);
        }catch{this.errors.push('Горячая клавиша недоступна или занята: '+key);}
      }
    }
    if(Platform.isMacOS&&this.settings.hideDock){
      if(!this.recovery())this.errors.push('Чтобы скрыть значок в Dock, включите значок в трее или клавишу показа окна.');
      else try{
        if(!this.runtime.app?.dock?.hide)throw Error();
        this.runtime.app.dock.hide();this.dockHidden=true;
      }catch{this.errors.push('Не удалось скрыть значок Obsidian в Dock.');}
    }
    const quitAware=this.listen(this.runtime.app,'before-quit',()=>{this.quitting=true;});
    if(this.settings.closeToTray&&!quitAware)this.errors.push('Сворачивание при закрытии недоступно: Obsidian не сообщает о выходе из приложения.');
    if(Platform.isWin&&this.settings.closeToTray&&quitAware)this.listen(this.runtime.window,'close',(event:any)=>{
      if(this.quitting||!this.recovery()||!this.availableWindow())return;
      try{
        // Obsidian also checks the native close event after a delay on Windows.
        event.preventDefault();
      }catch{/* The renderer beforeunload handler remains the primary guard. */}
    });
    const close=(event:any)=>{
      if(this.settings.closeToTray&&quitAware&&!this.quitting&&this.recovery()&&this.hide(false)){
        event.preventDefault();
        // Renderer cancellation complements Electron close on different builds.
        if(event.type==='beforeunload'){event.stopImmediatePropagation?.();event.returnValue=false;}
      }else if(event.type==='beforeunload'){
        // Release native resources while this renderer is still alive. Obsidian
        // does not guarantee plugin.onunload before destroying a vault window.
        this.release();
      }
    };
    // Remote callbacks run asynchronously; only the renderer can cancel
    // beforeunload synchronously, before Obsidian starts unloading plugins.
    const renderer=window;
    if(renderer?.addEventListener){
      renderer.addEventListener('beforeunload',close,true);this.cleanups.push(()=>renderer.removeEventListener('beforeunload',close,true));
      const keydown=(event:any)=>{if(event.repeat)return;for(const [key,action] of this.shortcutCallbacks){if(matchesDesktopShortcut(key,event)){event.preventDefault();event.stopImmediatePropagation?.();action();return;}}};
      renderer.addEventListener('keydown',keydown,true);this.cleanups.push(()=>renderer.removeEventListener('keydown',keydown,true));
    }
    this.listen(this.runtime.app,'activate',()=>{if(!this.quitting)this.show();});
    if(this.settings.closeToTray&&!this.recovery()){
      this.errors.push('Сворачивание отключено: включите рабочий значок в трее или горячую клавишу показа окна.');
      if(!this.runtime.window.isVisible?.())this.show();
    }
  }
  show(){
    if(!this.availableWindow())return false;
    try{const win=this.runtime.window;if(win.isMinimized?.())win.restore();win.show();win.focus();if(Platform.isMacOS)this.runtime.app?.focus?.({steal:true});return true;}
    catch{return false;}
  }
  hide(notify=true){
    if(!this.availableWindow()||!this.recovery()){
      if(notify)new Notice('Для сворачивания включите рабочий значок в трее или горячую клавишу показа окна.');return false;
    }
    try{this.runtime.window.hide();return true;}catch{return false;}
  }
  toggle(){if(this.runtime?.window?.isVisible?.())this.hide();else this.show();}
  async openExchangeFolder(){
    const folder=this.settings.exchangeFolder,adapter=this.plugin.app.vault.adapter;
    try{
      if(!safeRelative(folder))throw Error();
      let parent='';
      for(const part of folder.split('/')){
        parent=parent?parent+'/'+part:part;
        if(!await adapter.exists(parent)){
          try{await this.plugin.app.vault.createFolder(parent);}
          catch(error){if(!await adapter.exists(parent))throw error;}
        }
      }
      const fullPath=adapter.getFullPath?.(folder);
      if(!fullPath)throw Error();
      const error=this.runtime?.shell?.openPath?await this.runtime.shell.openPath(fullPath):'Shell unavailable';
      if(error){
        if(!this.plugin.app.openWithDefaultApp)throw Error(error);
        await this.plugin.app.openWithDefaultApp(folder);
      }
      new Notice('Папка обменника открыта: '+folder);
      return true;
    }catch{new Notice('Не удалось открыть папку обменника: '+folder);return false;}
  }
  save(patch:any){
    this.saveQueue=this.saveQueue.then(()=>this.persist(patch));return this.saveQueue;
  }
  private async persist(patch:any){
    if(this.disposed)return;
    const previous=this.settings;
    this.settings=normalizeDesktopSettings({...previous,...patch});
    this.apply();
    // Do not remove the last recovery path while the window is hidden.
    if(!this.recovery()&&this.availableWindow()&&!this.runtime.window.isVisible?.())this.show();
    try{await this.plugin.app.vault.adapter.write(this.path,JSON.stringify(this.settings,null,2));}
    catch{this.settings=previous;this.apply();new Notice('Не удалось сохранить настройки трея и горячих клавиш.');}
    if(this.errors.length)new Notice(this.errors.join('\n'));
  }
  quickNote(){
    // Serialize double presses to avoid reserving the same filename twice.
    this.noteQueue=this.noteQueue.then(async()=>{
      if(this.disposed)return;
      try{
        const folder=this.settings.quickNoteFolder;
        if(folder&&!safeRelative(folder))throw Error('Недопустимая папка для быстрых заметок.');
        const vault=this.plugin.app.vault;
        let parent='';for(const part of folder.split('/').filter(Boolean)){parent=parent?parent+'/'+part:part;if(!await vault.adapter.exists(parent))await vault.createFolder(parent);}
        const stamp=new Date().toISOString().replace(/[:.]/g,'-');
        let path='',suffix=0;
        do{path=(folder?folder+'/':'')+'Заметка '+stamp+(suffix?' '+suffix:'')+'.md';suffix++;}while(await vault.adapter.exists(path));
        if(this.disposed)return;
        const file=await vault.create(path,'# '+localizeMessage('Быстрая заметка')+'\n\n');
        if(this.disposed)return path;
        this.show();await this.plugin.app.workspace.getLeaf(false).openFile(file);
        return path;
      }catch{new Notice('Не удалось создать быструю заметку. Проверьте папку и доступ к хранилищу.');}
    });return this.noteQueue;
  }
  dispose(){this.disposed=true;if(this.availableWindow()&&!this.runtime.window.isVisible?.())this.show();this.release();this.statusBarButton?.remove();this.statusBarButton=null;}
  render(el:HTMLElement){
    el.createEl('h3',{text:'Трей и горячие клавиши'});
    if(Platform.isMobileApp){el.createEl('p',{text:'Трей и глобальные горячие клавиши доступны только на компьютере.'});return;}
    el.createEl('p',{text:'Эти настройки сохраняются только на этом устройстве. Глобальные клавиши работают и вне Obsidian. В других локальных хранилищах задайте другие сочетания, чтобы избежать конфликта.'});
    const status=el.createEl('p',{text:this.errors.join('\n')||'Настройки готовы к использованию.'});
    const refresh=()=>status.setText(this.errors.join('\n')||'Настройки готовы к использованию.');
    for(const [key,name,desc] of [
      ['tray','Значок в трее','Меню показа окна, папки обмена, быстрой заметки, синхронизации и настроек. На macOS значок находится в строке меню.'],
      ['closeToTray','Сворачивать при закрытии окна','Закрытие окна оставляет это хранилище работать в фоне. Для выхода выберите «Закрыть это хранилище» в меню трея.'],
      ['globalHotkeys','Глобальные горячие клавиши','Не заменяют горячие клавиши Obsidian. Занятые сочетания показаны ниже.']
    ])new Setting(el).setName(name).setDesc(desc).addToggle(t=>t.setValue((this.settings as any)[key]).onChange(async value=>{await this.save({[key]:value});t.setValue((this.settings as any)[key]);refresh();}));
    if(Platform.isMacOS)new Setting(el).setName('Скрывать значок Obsidian в Dock').setDesc('Для возврата окна нужен значок в строке меню или горячая клавиша.').addToggle(t=>t.setValue(this.settings.hideDock).onChange(async value=>{await this.save({hideDock:value});t.setValue(this.settings.hideDock);refresh();}));
    for(const [key,name] of [['showHideHotkey','Показать или скрыть окно'],['quickNoteHotkey','Создать быструю заметку']]){
      let value=(this.settings as any)[key];
      new Setting(el).setName(name).setDesc('Сочетание сохраняется кнопкой «Применить». Пустое поле отключает эту клавишу.').addText(t=>t.setValue(value).onChange(v=>{value=v;})).addButton(b=>b.setButtonText('Применить').onClick(async()=>{await this.save({[key]:value});refresh();}));
    }
    let folder=this.settings.quickNoteFolder;
    new Setting(el).setName('Папка быстрых заметок').setDesc('Путь внутри локального хранилища. Пустое поле — корень хранилища.').addText(t=>t.setValue(folder).onChange(v=>{folder=v.trim();})).addButton(b=>b.setButtonText('Применить').onClick(async()=>{if(folder&&!safeRelative(folder)){new Notice('Недопустимая папка для быстрых заметок.');return;}await this.save({quickNoteFolder:folder});refresh();}));
    let exchange=this.settings.exchangeFolder;
    new Setting(el).setName('Папка обмена').setDesc('Путь внутри хранилища. Если папки нет, она создаётся при открытии.').addText(t=>t.setValue(exchange).onChange(v=>{exchange=v.trim();})).addButton(b=>b.setButtonText('Применить').onClick(async()=>{if(!safeRelative(exchange)){new Notice('Недопустимая папка обмена.');return;}await this.save({exchangeFolder:exchange});refresh();}));
    new Setting(el).setName('Проверка управления окном').addButton(b=>b.setButtonText('Свернуть в трей').onClick(()=>this.hide())).addButton(b=>b.setButtonText('Создать быструю заметку').onClick(()=>void this.quickNote()));
    new Setting(el).setName('Горячие клавиши Obsidian').setDesc('Эти команды также доступны в палитре команд. Для сочетаний внутри Obsidian используйте его раздел «Горячие клавиши».').addButton(b=>b.setButtonText('Открыть горячие клавиши').onClick(()=>this.plugin.openDesktopHotkeys()));
  }
}
