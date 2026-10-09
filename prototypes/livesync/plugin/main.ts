import {settingsState,settingsStateLabel,capabilityHint} from './settings-state.mjs';
import {UnifiedVault} from './unified-vault';
import {VaultControls} from './vault-controls';
import {FreeRelay} from './free-relay';
import {isFreeRelayConnection as isFreeRelay} from './free-relay-settings.mjs';
import LiveSync from './upstream-main';
import {openObsidianSettings} from './common/obsidianSettings';
import {VIEW_TYPE_LOG} from './modules/features/Log/LogPaneView';
import { Notice, requestUrl, PluginSettingTab, Setting, Platform, setTooltip, setIcon } from 'obsidian';
import {diagnosticMessage,parameterFailure} from './diagnostic.mjs';
import {createSyncFeedback,syncLampState,syncUserMessages} from './sync-feedback.mjs';
import {requestPilot,responseData,responseError,connectionFailure} from './pilot-http.mjs';
import {Logger,LOG_LEVEL_INFO} from 'octagonal-wheels/common/logger';
import { createRecoveryLoop,nativeConnectionReachable } from './recovery.mjs';
import { createStorageWarning } from './storage-warning.mjs';
import { createNewVaultSettings } from '@vrtmrz/livesync-commonlib/settings';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
import {CollaborativeNotes,reserved} from './collaboration';
import {TelegramInbox} from './telegram';
import {SharedFolders} from './folders';
import {Workspaces} from './workspaces';
import {pluginSyncSettings} from './plugin-sync.mjs';
import {localizeMessage,messageLanguage,setMessageLanguageSource,observeLocalizedUI} from './localized-obsidian';
import {renderLanguageSetting} from './language-settings';
import {getStoragePathFromUXFileInfo} from '@vrtmrz/livesync-commonlib/compat/common/typeUtils';
import {DesktopControls} from './desktop';
import {brandLogo} from './brand-logo';
const BASE='https://arcalink.ru';
async function api(path:string, body?:any, token?:string) {
  const response=await requestUrl({url:BASE+path,method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),throw:false});
  if(response.status>=400)throw Error(response.json?.message||response.json?.error||'ArcaLink request failed');
  return response.json;
}


export type { LiveSyncCore } from './upstream-main';
export default class ArcaLinkPilot extends LiveSync {
  pilotRecovery: any;
  pilotStorageWarning: any;
  async loadPilotStorageStatus(){
    const s=this.core.services.setting.currentSettings();
    if(isFreeRelay(s)||!s.isConfigured||!navigator.onLine)return null;
    const r=await requestUrl({url:this.unifiedVault.base+'/storage-status',headers:{Authorization:'Basic '+btoa(s.couchDB_USER+':'+s.couchDB_PASSWORD)},throw:false});
    return r.status===200?{...r.json,key:s.couchDB_USER+':'+s.couchDB_DBNAME}:null;
  }
  collaboration!: CollaborativeNotes;
  folders=new SharedFolders(this);
  telegram=new TelegramInbox(this);
  desktop=new DesktopControls(this);
  openDesktopSettings(){this.pilotSettingsTab='desktop';openObsidianSettings(this.app,this.manifest.id);}
  openDesktopHotkeys(){openObsidianSettings(this.app,'hotkeys');}
  pilotSettingsTab=this.manifest.id==='arcalink-free-lab'?'vaults':'account';
  override renderPilotSettings=(el:HTMLElement)=>{new PilotTab(this).renderInto(el);};
  get pilotDirectory(){return this.app.vault.configDir+'/plugins/'+this.manifest.id;}
  workspaces=new Workspaces(this);
  freeRelay=new FreeRelay(this);
  unifiedVault=new UnifiedVault(this);
  arcalinkP2P:any;
  async prepareFreeRelaySettings(settings:any,signal:AbortSignal){return isFreeRelay(settings)?this.freeRelay.prepare(settings,signal):null;}
  cloudFeatures:Promise<void>|null=null;
  sharedFeatures:Promise<void>|null=null;
  async initializeCloudFeatures(){
    const free=isFreeRelay(this.core.services.setting.currentSettings());
    // Existing shared files still need their cached CRDT and read-only binding on Free.
    if(free&&!this.folders.records.length&&!await this.app.vault.adapter.exists(this.collaboration.registry))return;
    this.sharedFeatures??=(async()=>{
      await this.folders.init();
      this.app.workspace.onLayoutReady(()=>{void this.collaboration.init().catch(e=>new Notice(e.message));});
    })();
    await this.sharedFeatures;
    if(free)return;
    this.cloudFeatures??=Promise.resolve().then(()=>{this.app.workspace.onLayoutReady(()=>this.telegram.init());});
    await this.cloudFeatures;
  }
  async connectPilot(email:string,password:string){return this.workspaces.login(email,password);}
  pilotSyncFeedback: any;
  async syncDiagnostic(){
    const s=this.core.services.setting.currentSettings();
    if(isFreeRelay(s)||!s.isConfigured||!s.couchDB_USER.startsWith('pilot_'))return null;
    try{const r=await requestUrl({url:this.unifiedVault.base+'/storage-status',headers:{Authorization:'Basic '+btoa(s.couchDB_USER+':'+s.couchDB_PASSWORD)},throw:false});return diagnosticMessage(r.status,r.json);}catch{return null;}
  }
  // Upstream currently declares onload as void even though Obsidian supports an async hook.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Upstream still declares this supported Obsidian lifecycle hook as void.
  override async onload() {
    setMessageLanguageSource(()=>this.core?.services?.setting?.currentSettings()?.displayLanguage);
    this.register(()=>setMessageLanguageSource());
    try{this.folders.records=JSON.parse(await this.app.vault.adapter.read(this.folders.registry));}catch{/* No registry exists on a fresh install. */}
    super.onload();

    const openVaultControls=()=>{this.pilotSettingsTab='vaults';openObsidianSettings(this.app,this.manifest.id);};
    window.addEventListener('arcalink-open-vault-controls',openVaultControls);
    this.register(()=>window.removeEventListener('arcalink-open-vault-controls',openVaultControls));
    this.app.workspace.onLayoutReady(()=>{for(const type of ['p2p-server-status','p2p-replicator'])for(const leaf of this.app.workspace.getLeavesOfType(type))leaf.detach();});
    const services = this.core.services;
    this.pilotSyncFeedback=createSyncFeedback({diagnose:()=>this.syncDiagnostic(),notify:(message:string)=>{Logger(message,LOG_LEVEL_INFO);return new Notice(message,10000);}});
    services.appLifecycle.getUnresolvedMessages.addHandler(async()=>[...this.pilotSyncFeedback.messages,...this.folders.syncFeedback.messages]);
    // Preparation succeeded. Clear only our previous diagnostic, never other
    // modules' unresolved errors, and hide its still-visible notification.
    services.replication.onBeforeReplicate.addHandler(async()=>{this.pilotSyncFeedback.clear();return true;},-10);
    services.appLifecycle.onSettingLoaded.addHandler(async()=>{
      await services.setting.applyPartial(pluginSyncSettings(services.setting.currentSettings().syncInternalFiles,this.app.vault.configDir,this.manifest.id));
      return true;
    },-20);
    services.appLifecycle.onSettingLoaded.addHandler(()=>this.workspaces.pauseUnfinishedMerge());
    // The initial scan finishes before upstream starts watching files. Catch
    // edits made in that gap after the priority-0 watcher has been registered.
    services.appLifecycle.onFirstInitialise.addHandler(async()=>{
      await services.vault.scanVault(false,false,true);
      return true;
    },500);
    this.pilotStorageWarning=createStorageWarning({load:()=>this.loadPilotStorageStatus(),notify:(message:string)=>{new Notice(message,15000);}});
    services.appLifecycle.onLoaded.addHandler(async()=>{void this.pilotStorageWarning.tick();return true;},600);
    this.app.workspace.onLayoutReady(()=>{void this.pilotStorageWarning.tick();this.registerInterval(window.setInterval(()=>void this.pilotStorageWarning.tick(),5*60*1000));});
    const lamp=this.addStatusBarItem();
    lamp.addClass('arcalink-sync-lamp');
    lamp.setText('●');
    lamp.setAttribute('role','button');
    lamp.tabIndex=0;
    const openPilotSettings=()=>openObsidianSettings(this.app,this.manifest.id);
    this.registerDomEvent(lamp,'click',openPilotSettings);
    this.registerDomEvent(lamp,'keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openPilotSettings();}});
    let lampBusy=false,lastMessage='',lastTooltip='';
    const refreshLamp=async()=>{
      if(lampBusy)return;lampBusy=true;
      try {
        const errors=(await services.appLifecycle.getUnresolvedMessages()).flat().filter(Boolean).map(String);
        const state=services.replicator.replicationStatics.value;
        const status=String(state.syncStatus||'');
        const editor=this.app.workspace.containerEl.querySelector('.livesync-status');
        const log=editor?.querySelector('.livesync-status-logmessage')?.textContent?.trim();
        if(log)lastMessage=log;
        // Missing editor status is not evidence of a disconnected replicator.
        const summary=editor?.querySelector('.livesync-status-statusline')?.textContent?.trim()||'';
        const offline=!navigator.onLine;
        const settings=services.setting.currentSettings();
        if(isFreeRelay(settings)){const connected=this.arcalinkP2P?.transportLifecycle.isConnected,peers=this.arcalinkP2P?.peerDirectory.getPeers()||[];lamp.dataset.state=offline?'offline':connected&&peers.length?'ready':'idle';setTooltip(lamp,offline?'Free: нет интернета':!connected?'Free: нет подключения':!peers.length?'Free: ожидаем второе устройство':'Free: второе устройство подключено; состояние передачи — в панели устройств',{placement:'top'});return;}
        const paused=services.appLifecycle.isSuspended(),automaticOff=settings.isConfigured&&!settings.liveSync;
        const kind=syncLampState({errors,status,offline,paused,automaticOff});
        lamp.dataset.state=kind;
        const label=kind==='idle'&&paused?'Синхронизация приостановлена':kind==='idle'&&automaticOff?'Автоматическая синхронизация выключена':{error:'Ошибка синхронизации',offline:'Нет подключения к интернету',ready:'Синхронизация подключена',active:'Синхронизация выполняется',idle:'Синхронизация ожидает'}[kind];
        // setTooltip owns aria-label; resetting it would erase the detailed hover text.
        const tooltip=[label,summary,...syncUserMessages([...errors,lastMessage].filter(Boolean),this.folders.syncFeedback.messages)].filter(Boolean).map(localizeMessage).join('\n');if(tooltip!==lastTooltip){lastTooltip=tooltip;setTooltip(lamp,tooltip,{placement:'top'});}
      } catch {lamp.dataset.state='idle';setTooltip(lamp,localizeMessage('Синхронизация запускается'),{placement:'top'});}
      finally {lampBusy=false;}
    };
    this.app.workspace.onLayoutReady(()=>{void refreshLamp();this.registerInterval(window.setInterval(()=>void refreshLamp(),1000));});

    (services.API as any).pilotFailureMessage=async()=>await this.syncDiagnostic()||parameterFailure;
    (services.API as any).pilotReportParameterFailure=(message:string,prominent:boolean)=>this.pilotSyncFeedback.report(message,prominent);
    // Report before the engine's unattended recovery handler stops the chain.
    services.replication.onReplicationFailed.addHandler(async()=>{await this.pilotSyncFeedback.failed();return true;},-10);
    services.vault.isTargetFile.addHandler(async file=>!reserved(getStoragePathFromUXFileInfo(file))&&!this.folders.contains(getStoragePathFromUXFileInfo(file)),0);
    this.collaboration=new CollaborativeNotes(this);
    services.replication.onBeforeReplicate.addHandler(async()=>isFreeRelay(services.setting.currentSettings())?true:this.folders.refreshBeforeSync(),0);
    services.appLifecycle.onLoaded.addHandler(async()=>{await this.initializeCloudFeatures();return true;},500);
    this.pilotRecovery = createRecoveryLoop({
      eligible: () => {
        const s = services.setting.currentSettings();
        return !isFreeRelay(s) && s.isConfigured && s.liveSync && services.appLifecycle.isReady()
          && !services.appLifecycle.isSuspended() && services.API.isOnline;
      },
      reachable: async () => {
        const s = services.setting.currentSettings();
        return nativeConnectionReachable(services.API.nativeFetch.bind(services.API),s.couchDB_URI.replace(/\/$/, '') + '/' + encodeURIComponent(s.couchDB_DBNAME),{
          Authorization:'Basic '+btoa(unescape(encodeURIComponent(s.couchDB_USER+':'+s.couchDB_PASSWORD)))
        });
      },
      resume: () => services.control.applySettings(),
      start: () => services.replication.startContinuous({ trigger: 'resume', interaction: { kind: 'forbidden' } }),
    });
    this.registerInterval(window.setInterval(() => { void this.pilotRecovery.tick(); }, 15000));
    this.addCommand({ id: 'pilot-recovery-status', name: 'Синхронизация: состояние восстановления', callback: () => {
      new Notice(JSON.stringify(this.pilotRecovery.status));
    }});
    const reconcileVault=()=>{void this.unifiedVault.poll();};
    services.appLifecycle.onLoaded.addHandler(async()=>{reconcileVault();return true;},650);
    this.registerInterval(window.setInterval(reconcileVault,60000));
    window.addEventListener('online',reconcileVault);this.register(()=>window.removeEventListener('online',reconcileVault));
    const renewFree=()=>{void this.freeRelay.renew().catch(()=>{});};
    this.registerInterval(window.setInterval(renewFree,15000));
    for(const name of ['online','focus','pageshow','arcalink-free-signal-change']){window.addEventListener(name,renewFree);this.register(()=>window.removeEventListener(name,renewFree));}
    document.addEventListener('visibilitychange',renewFree);this.register(()=>document.removeEventListener('visibilitychange',renewFree));
    await this.desktop.init();
  }
  override onunload() {
    this.desktop.dispose();
    this.pilotSyncFeedback?.clear();
    this.telegram.dispose();
    this.folders.dispose();
    this.workspaces.dispose();
    this.collaboration?.dispose();
    this.pilotRecovery?.dispose();
    this.pilotStorageWarning?.dispose();
    super.onunload();
  }
}

class PilotTab extends PluginSettingTab {
  pilot:ArcaLinkPilot;
  constructor(pilot:ArcaLinkPilot){super(pilot.app,pilot);this.pilot=pilot;}
  override display(){this.renderInto(this.containerEl);}
  renderInto(el:HTMLElement){
    (el as any).__arcalinkModeCleanup?.();
    let updateSectionStates=()=>{};
    let accountStatus:any=null,signedIn=!!this.pilot.workspaces.pending;
    const initialMode=this.pilot.core.services.setting.currentSettings()?.remoteType;
    let stopLocalization=()=>{};
    const cleanup=()=>{window.clearInterval(modeTimer);stopLocalization();};
    const modeTimer=window.setInterval(()=>{if(!el.isConnected){cleanup();return;}if(this.pilot.core.services.setting.currentSettings()?.remoteType!==initialMode){this.renderInto(el);return;}updateSectionStates();},1000);
    (el as any).__arcalinkModeCleanup=cleanup;this.pilot.register(cleanup);
    if(this.pilot.pilotSettingsTab==='free')this.pilot.pilotSettingsTab='vaults';
    el.empty();
    const heading=new Setting(el).setName('').setHeading();
    heading.settingEl.addClass('arcalink-settings-heading');
    const brand=heading.nameEl.createEl('a',{cls:'arcalink-brand-link',href:BASE,attr:{target:'_blank',rel:'noopener noreferrer','aria-label':'ArcaLink — перейти на сайт'}});
    brand.createEl('img',{attr:{src:brandLogo,alt:'',width:'36',height:'36'}});
    brand.createSpan({text:'ArcaLink'});setTooltip(brand,'Открыть сайт ArcaLink',{placement:'top'});
    renderLanguageSetting(el,this.pilot.core.services.setting,()=>this.renderInto(el));
    el.createEl('p',{text:'Синхронизация заметок между устройствами. На всех устройствах используйте один аккаунт. Не включайте одновременно другие плагины синхронизации.'});
    const tabs=[
      {id:'account',label:'Аккаунт',icon:'user-round'},
      {id:'vaults',label:'Хранилища',icon:'database'},
      {id:'sync',label:'Синхронизация',icon:'refresh-cw'},
      {id:'sharing',label:'Совместная работа',icon:'users-round'},
      {id:'telegram',label:'Telegram',icon:'send'},
      {id:'desktop',label:'Трей и горячие клавиши',icon:'keyboard'},
      {id:'help',label:'Краткая инструкция',icon:'book-open'},
      {id:'changes',label:'История изменений',icon:'history'}
    ];
    const navigation=el.createDiv({cls:'arcalink-settings-tabs'});
    navigation.setAttribute('role','tablist');navigation.setAttribute('aria-label','Разделы настроек ArcaLink');
    const panels:Record<string,HTMLElement>={},buttons:HTMLButtonElement[]=[];
    const select=(id:string)=>{
      this.pilot.pilotSettingsTab=id;
      tabs.forEach((tab,index)=>{const active=tab.id===id;buttons[index].setAttribute('aria-selected',String(active));buttons[index].tabIndex=active?0:-1;panels[tab.id].hidden=!active;});
    };
    tabs.forEach((tab,index)=>{
      const button=navigation.createEl('button',{cls:'arcalink-settings-tab',attr:{type:'button',role:'tab',id:'arcalink-tab-'+tab.id,'aria-controls':'arcalink-panel-'+tab.id,'aria-label':tab.label}});
      button.hidden=this.pilot.manifest.id==='arcalink-free-lab'&&!['account','vaults','sync','sharing','telegram','desktop','help'].includes(tab.id);
      const icon=button.createSpan({cls:'arcalink-settings-tab-icon'});icon.setAttribute('aria-hidden','true');setIcon(icon,tab.icon);
      setTooltip(button,tab.label,{placement:'top'});
      const panel=el.createDiv({cls:'arcalink-settings-panel',attr:{role:'tabpanel',id:'arcalink-panel-'+tab.id,'aria-labelledby':button.id}});
      panels[tab.id]=panel;buttons.push(button);
      button.addEventListener('click',()=>select(tab.id));
      button.addEventListener('keydown',event=>{
        const visible=tabs.map((_,i)=>i).filter(i=>!buttons[i].hidden),position=visible.indexOf(index);
        const next=event.key==='ArrowRight'?visible[(position+1)%visible.length]:event.key==='ArrowLeft'?visible[(position+visible.length-1)%visible.length]:event.key==='Home'?visible[0]:event.key==='End'?visible[visible.length-1]:-1;
        if(next<0)return;event.preventDefault();select(tabs[next].id);buttons[next].focus();
      });
    });
    select(tabs.some((tab,index)=>tab.id===this.pilot.pilotSettingsTab&&!buttons[index].hidden)?this.pilot.pilotSettingsTab:'account');
    const settings=this.pilot.core.services.setting.currentSettings(),pending=this.pilot.workspaces.pending;
    const tariffGate=(control:HTMLElement,capability:string)=>{
      const gate=document.createElement('fieldset');gate.className='arcalink-tariff-gate';gate.setAttribute('data-arcalink-capability',capability);
      control.replaceWith(gate);gate.append(control);
      for(const event of ['click','keydown'])gate.addEventListener(event,e=>{if(gate.disabled){e.preventDefault();e.stopImmediatePropagation();}},true);
      return gate;
    };
    const hints:Record<string,HTMLElement>={};
    for(const id of ['sharing','telegram'])hints[id]=panels[id].createEl('p',{cls:'arcalink-tariff-hint',text:capabilityHint(id==='sharing'?'collaboration':'cloud')});
    updateSectionStates=()=>{
      const current=this.pilot.core.services.setting.currentSettings();
      const state=settingsState({settings:current,policy:this.pilot.unifiedVault.state,account:accountStatus,signedIn,telegram:this.pilot.telegram.configured,desktop:this.pilot.desktop.settings,shared:!!(this.pilot.collaboration.records.length||this.pilot.folders.records.length)});
      tabs.forEach((tab,index)=>{
        const value=state.sections[tab.id]||'unconfigured',button=buttons[index];
        if(button.getAttribute('data-state')!==value){
          button.setAttribute('data-state',value);
          const label=localizeMessage(tab.label)+(settingsStateLabel(value)?' — '+localizeMessage(settingsStateLabel(value)):'');
          button.setAttribute('aria-label',label);setTooltip(button,label,{placement:'top'});
        }
      });
      for(const id of ['sharing','telegram'])hints[id].hidden=state.sections[id]!=='unavailable';
      el.querySelectorAll<HTMLElement>('[data-arcalink-capability]').forEach(control=>{
        const unavailable=state.capabilities[control.getAttribute('data-arcalink-capability')!]===false;
        control.classList.toggle('arcalink-setting-unavailable',unavailable);
        if(control instanceof HTMLFieldSetElement)control.disabled=unavailable;
      });
    };

    const linked=new Setting(panels.vaults).setName('Хранилище').setDesc('Хранилище не подключено. Для скачивания заметок выберите то же серверное хранилище, что и на первом устройстве.');
    const storage=new Setting(panels.vaults).setName('Место в хранилище').setDesc('Данные пока не загружены');
    const meter=panels.vaults.createEl('progress',{cls:'arcalink-storage-meter'});meter.max=100;meter.value=0;meter.setAttribute('aria-label','Заполнение хранилища');meter.hidden=true;storage.settingEl.setAttribute('data-arcalink-capability','cloud');
    const encryption=new Setting(panels.vaults).setName('Шифрование личных заметок').setDesc(isFreeRelay(settings)?'Настройка шифрования сохранена. Изменить её можно после подключения облачного хранилища.':settings.encrypt?'Включено. Смена режима переносит заметки в новое серверное хранилище.':'Выключено. Сервер может читать личные заметки. Смена режима переносит данные в новое хранилище.').addToggle(t=>t.setValue(!!settings.encrypt).setDisabled(!settings.isConfigured).onChange(value=>{t.setValue(!!settings.encrypt);this.pilot.workspaces.encryptionDialog(value);}));
    tariffGate(encryption.controlEl,'cloud');encryption.settingEl.setAttribute('data-arcalink-capability','cloud');
    this.pilot.unifiedVault.render(panels.vaults);
    const catalog=panels.vaults.createDiv();
    const loadCatalog=()=>{catalog.empty();if(isFreeRelay(settings))return;else if(settings.isConfigured||pending)void this.pilot.workspaces.renderCatalog(catalog);else catalog.createEl('p',{text:'Сначала войдите в аккаунт на вкладке «Аккаунт». Затем выберите серверное хранилище и нажмите «Подключить».'});};
    new Setting(panels.vaults).setName('Серверные хранилища').setDesc('Выберите серверное хранилище и подтвердите действие кнопкой «Подключить». Создание хранилища не меняет текущее подключение.').addButton(b=>{b.setButtonText('Обновить список').setDisabled(!settings.isConfigured&&!pending).onClick(loadCatalog);tariffGate(b.buttonEl,'cloud');}).settingEl.setAttribute('data-arcalink-capability','cloud');
    panels.vaults.append(catalog);tariffGate(catalog,'cloud');loadCatalog();
    panels.account.createEl('a',{text:'Регистрация и скачивание',href:BASE+'/register'});
    new Setting(panels.sharing).setName('Совместные заметки').setDesc('Редактируйте заметки вместе. Сервер видит их текст. Пригласить редактора или читателя можно через палитру команд. Всем участникам нужна актуальная версия плагина.').addButton(b=>{b.setButtonText('Создать заметку').onClick(()=>this.pilot.collaboration.prompt('Совместная заметка','Название',async title=>this.pilot.collaboration.create(title)));tariffGate(b.buttonEl,'collaboration');}).addButton(b=>b.setButtonText('Присоединиться').onClick(()=>this.pilot.collaboration.prompt('Присоединиться','Код приглашения',async code=>this.pilot.collaboration.join(code))));
    this.pilot.workspaces.renderRecovery(panels.vaults);
    this.pilot.folders.render(panels.sharing,button=>tariffGate(button,'collaboration'));
    if(isFreeRelay(settings))new VaultControls(this.pilot).render(panels.vaults);
    this.pilot.desktop.render(panels.desktop);
    const telegramControls=panels.telegram.createDiv();tariffGate(telegramControls,'cloud');
    this.pilot.telegram.render(telegramControls);
    const telegramSection=panels.telegram.querySelector('details');if(telegramSection)telegramSection.open=true;
    const account=new Setting(panels.account).setName('Аккаунт').setDesc(settings.isConfigured?'Проверяем вход в аккаунт…':pending?'Вход выполнен: '+pending.email:'Вход не выполнен');
    const subscription=new Setting(panels.account).setName('Подписка').setDesc('Данные пока не загружены');
    let email=pending?.email||'',authenticatedEmail=email,password='',emailEdited=false;
    let emailInput:any;
    let accountBusy=false,retryAccount:any,retryStorage:any;
    const refreshAccount=async()=>{
      if(accountBusy)return;accountBusy=true;retryAccount?.setDisabled(true);retryStorage?.setDisabled(true);
      try{
      const settings=this.pilot.core.services.setting.currentSettings();
      const sessionPath=this.pilot.pilotDirectory+'/pilot-session.json';
      let saved:any={};
      try{if(await this.pilot.app.vault.adapter.exists(sessionPath)){saved=JSON.parse(await this.pilot.app.vault.adapter.read(sessionPath));authenticatedEmail=pending?.email||(typeof saved.email==='string'?saved.email:'');if(!emailEdited){email=authenticatedEmail;emailInput?.setValue(email);}}}catch{/* A damaged optional session is handled as signed out. */}
      if(isFreeRelay(settings)){const session=await this.pilot.freeRelay.session();signedIn=!!session;account.setDesc(session?'Вход выполнен: '+session.email:'Войдите в настройках хранилища');subscription.setDesc('Free: ретрансляция без облачной копии');storage.setDesc('Файлы хранятся только на устройствах');linked.setDesc('Оба устройства должны быть открыты');return;}
      if(!settings.isConfigured){subscription.setDesc(pending?'Подключите хранилище для просмотра подписки':'Войдите в аккаунт для просмотра подписки');storage.setDesc('Подключите хранилище для просмотра свободного места');return;}
      const describeConnection=(title:string)=>linked.setDesc('Локальное хранилище «'+this.pilot.app.vault.getName()+'» подключено к серверному «'+title+'». Для обмена заметками на всех устройствах выберите одно и то же серверное хранилище.');
      if(saved.workspaceTitle)describeConnection(saved.workspaceTitle);
      else linked.setDesc('Подключение сохранено. Проверяем название серверного хранилища…');
      account.setDesc('Проверяем вход в аккаунт…');meter.hidden=true;
      const headers={Authorization:'Basic '+btoa(settings.couchDB_USER+':'+settings.couchDB_PASSWORD)};
      const outcomes=await Promise.allSettled([
        requestPilot(requestUrl,{url:this.pilot.unifiedVault.base+'/account-status',headers,throw:false}),
        requestPilot(requestUrl,{url:this.pilot.unifiedVault.base+'/storage-status',headers,throw:false}),
        this.pilot.workspaces.api('list')
      ]);
      if(!el.isConnected)return;
      const catalog=outcomes[2];
      const selected=catalog.status==='fulfilled'?catalog.value?.workspaces?.find((w:any)=>w.database===settings.couchDB_DBNAME):null;
      if(selected)describeConnection(selected.title);
      else if(!saved.workspaceTitle)linked.setDesc('Подключение сохранено, но название сервера проверить не удалось. На вкладке «Хранилища» проверьте, что выбран тот же сервер, что и на первом устройстве.');
      const me=outcomes[0];
      if(me.status==='fulfilled'&&me.value.status===200&&responseData(me.value)){const user=responseData(me.value);accountStatus=user;signedIn=true;authenticatedEmail=user.email||authenticatedEmail;if(!emailEdited){email=authenticatedEmail;emailInput?.setValue(email);}account.setDesc('Вход выполнен: '+authenticatedEmail);
        const plans:any={free:'Free',begin:'Begin',solo:'Pro',team:'Pro',personal_cloud:'Pro',pro:'Pro'};const states:any={active:'активна',grace:'льготный период',past_due:'ожидается оплата',suspended:'приостановлена',canceled:'отменена',cancelled:'отменена'};
        subscription.setDesc('Тариф: '+localizeMessage(plans[user.plan]||user.plan||'не указан')+'. Статус: '+localizeMessage(states[user.billing_status]||'не определён')+'.');
      }else{const reason=me.status==='fulfilled'?responseError(me.value):connectionFailure(me.reason);account.setDesc('Не удалось проверить вход'+(authenticatedEmail?': '+authenticatedEmail:'')+'. '+reason);subscription.setDesc('Не удалось загрузить подписку. Повторите проверку позже.');}
      const space=outcomes[1];
      if(space.status==='fulfilled'&&space.value.status===200&&responseData(space.value)){const {used_bytes:used,limit_bytes:limit}=responseData(space.value);if(Number.isFinite(used)&&used>=0&&limit===0){storage.setDesc('Free не хранит файлы на сервере. Облачная синхронизация отключена. Срок хранения прежней копии указан в настройках хранилища. Для облачной синхронизации продлите Begin или Pro.');meter.hidden=true;}else if(Number.isFinite(used)&&used>=0&&Number.isFinite(limit)&&limit>0){const size=(n:number)=>(n/1024/1024).toLocaleString(messageLanguage()==='ru'?'ru-RU':'en-US',{maximumFractionDigits:1})+' '+localizeMessage('МБ');storage.setDesc('Занято '+size(used)+' из '+size(limit)+'. Свободно '+size(Math.max(0,limit-used))+'.');meter.value=Math.min(100,used/limit*100);meter.hidden=false;meter.setAttribute('aria-valuetext',Math.round(used/limit*100)+'% занято');}else storage.setDesc('Сервер вернул некорректные данные о хранилище');}
      else storage.setDesc('Не удалось загрузить данные о свободном месте.');
      }finally{updateSectionStates();accountBusy=false;retryAccount?.setDisabled(false);retryStorage?.setDisabled(false);}
    };
    new Setting(panels.account).setName('Проверка аккаунта').setDesc('Повторить загрузку статуса входа и подписки.').addButton(b=>{retryAccount=b;b.setButtonText('Повторить проверку').onClick(refreshAccount);});
    new Setting(panels.vaults).setName('Проверка хранилища').setDesc('Обновить сведения о подключении и свободном месте.').addButton(b=>{retryStorage=b;b.setButtonText('Обновить данные').onClick(refreshAccount);tariffGate(b.buttonEl,'cloud');}).settingEl.setAttribute('data-arcalink-capability','cloud');
    void refreshAccount();
    new Setting(panels.account).setName('Электронная почта').addText(t=>{emailInput=t;t.setPlaceholder('Почта аккаунта').setValue(email).onChange(v=>{emailEdited=true;email=v.trim().toLowerCase();});});
    new Setting(panels.account).setName('Пароль').addText(t=>{t.inputEl.type='password';t.onChange(v=>password=v);});
    new Setting(panels.account).setName('Вход в ArcaLink').setDesc('Вход не подключает хранилище. Выберите его на вкладке «Хранилища» и нажмите «Подключить». Если вход уже выполнен, пароль можно не вводить.')
      .addButton(b=>b.setButtonText('Войти').setCta().onClick(async()=>{
        b.setDisabled(true);try{await this.pilot.connectPilot(email,password);password='';new Notice('Вход выполнен: '+email+'. Для подключения выберите хранилище на вкладке «Хранилища».');this.renderInto(el);}
        catch(e:any){new Notice(e.message||'Не удалось войти в аккаунт');}finally{b.setDisabled(false);}
      }));
    new Setting(panels.account).setName('Восстановление пароля').setDesc('Получите код на почту и задайте новый пароль на сайте ArcaLink. Затем войдите здесь с новым паролем.').addButton(b=>b.setButtonText('Восстановить пароль').onClick(()=>window.open(BASE+'/recovery','_blank','noopener,noreferrer')));
    new Setting(panels.help).setName('Краткая инструкция').setHeading();
    const steps=panels.help.createEl('ol');
    for(const text of [
      'На вкладке «Аккаунт» войдите в ArcaLink. Если аккаунта ещё нет, откройте «Регистрация и скачивание». Забыли пароль — нажмите «Восстановить пароль».',
      'На вкладке «Хранилища» выберите серверное хранилище и нажмите «Подключить». Создать новое можно отдельно: создание не меняет текущее подключение.',
      'При подключении или смене серверного хранилища локальные и серверные заметки объединяются. Прочитайте предупреждение и подтвердите слияние. Перед первым подключением сохраните резервную копию важных заметок.',
      'На втором устройстве войдите в тот же аккаунт и подключите то же серверное хранилище. Дождитесь завершения слияния и загрузки заметок.',
      'На вкладке «Синхронизация» включите автоматическую синхронизацию. При необходимости включите «Синхронизировать плагины» на каждом устройстве; новые плагины активируйте вручную, после обновления их файлов перезапустите Obsidian.',
      'Лампочка внизу показывает состояние синхронизации. Наведите мышь, чтобы прочитать сообщения; нажмите, чтобы открыть настройки. Подробный журнал доступен через «Синхронизация» → «Показать лог».',
      'Режим шифрования, свободное место и управление серверными хранилищами находятся во «Хранилищах». Совместные заметки и общие папки — в «Совместной работе», бот — в «Telegram». Обновления устанавливаются через каталог плагинов Obsidian.'
    ])steps.createEl('li',{text});
    new Setting(panels.changes).setName('История изменений').setHeading();
    panels.changes.createEl('p',{text:'Установлена версия '+this.pilot.manifest.version+'. Здесь перечислены последние изменения плагина ArcaLink.'});
    for(const [version,items] of [
      ['1.0.0',['Первый публичный выпуск ArcaLink Sync для каталога сообщества Obsidian.','Синхронизация личных хранилищ между устройствами, общие папки, совместное редактирование и получение заметок из Telegram.']]
    ] as [string,string[]][]){new Setting(panels.changes).setName('Версия '+version).setHeading();const list=panels.changes.createEl('ul');for(const text of items)list.createEl('li',{text});}
    new Setting(panels.sync).setName('Автоматическая синхронизация').setDesc('Синхронизировать заметки при изменениях и запуске приложения.').addToggle(t=>t.setValue(!!settings.liveSync).onChange(async value=>{
      try{if(value&&(this.pilot.workspaces.busy||await this.pilot.workspaces.pendingMerge())){new Notice('Сначала завершите слияние хранилищ');this.renderInto(el);return;}await this.pilot.core.services.setting.applyPartial({liveSync:value,syncOnSave:value,syncOnStart:value} as any,true);await this.pilot.core.services.control.applySettings();}
      catch{new Notice('Не удалось изменить режим синхронизации. Проверьте подключение и повторите попытку.');this.renderInto(el);}
    }));
    new Setting(panels.sync).setName('Синхронизировать плагины').setDesc('Передавать файлы и настройки сторонних плагинов между устройствами. Включите на каждом устройстве. Настройки подключения и служебные файлы ArcaLink не передаются. Новые плагины включайте вручную; после обновления файлов перезапустите Obsidian.').addToggle(t=>t.setValue(!!settings.syncInternalFiles).onChange(async value=>{
      t.setDisabled(true);
      try{
        if(value&&(this.pilot.workspaces.busy||await this.pilot.workspaces.pendingMerge()))throw Error('Сначала завершите слияние хранилищ');
        await this.pilot.core.services.setting.applyPartial(pluginSyncSettings(value,this.pilot.app.vault.configDir,this.pilot.manifest.id),true);
        if(this.pilot.core.services.appLifecycle.isReady())await this.pilot.core.services.control.applySettings();
      }catch(e:any){new Notice(e.message==='Сначала завершите слияние хранилищ'?e.message:'Не удалось изменить синхронизацию плагинов. Повторите попытку.');this.renderInto(el);}
      finally{t.setDisabled(false);}
    }));
    new Setting(panels.vaults).setName('Предупреждение о заполнении').setDesc('Автоматическое уведомление при заполнении 95% квоты аккаунта. Проверка при запуске и каждые 5 минут.').settingEl.setAttribute('data-arcalink-capability','cloud');
    new Setting(panels.sync).setName('Журнал синхронизации').addButton(b=>b.setButtonText('Показать лог').onClick(async()=>{
      (this.pilot.app as typeof this.pilot.app & {setting:{close():void}}).setting.close();
      await this.pilot.core.services.API.showWindow(VIEW_TYPE_LOG);
    }));
    const diagnostic=new Setting(panels.sync).setName('Диагностика подключения').setDesc('Проверить доступ к серверу и свободное место.').addButton(b=>b.setButtonText('Проверить подключение').onClick(async()=>{
      const settings=this.pilot.core.services.setting.currentSettings();
      if(!settings.isConfigured){new Notice('Сначала войдите в аккаунт ArcaLink.');return;}
      b.setDisabled(true);try{const r=await requestUrl({url:this.pilot.unifiedVault.base+'/storage-status',headers:{Authorization:'Basic '+btoa(settings.couchDB_USER+':'+settings.couchDB_PASSWORD)},throw:false});const error=diagnosticMessage(r.status,r.json);new Notice(error||(r.status===200?'Подключение к серверу работает.':'Сервер временно недоступен. Повторите попытку позже.'));}catch{new Notice('Не удалось связаться с сервером. Проверьте подключение к интернету.');}finally{b.setDisabled(false);}
    }));
    tariffGate(diagnostic.controlEl,'cloud');diagnostic.settingEl.setAttribute('data-arcalink-capability','cloud');
    updateSectionStates();
    stopLocalization=observeLocalizedUI(el);
  }
}
