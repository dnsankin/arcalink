import {Notice,requestUrl,Setting,Platform} from 'obsidian';
import {accountClientVersion} from './client-version.mjs';
import {createNewVaultSettings} from '@vrtmrz/livesync-commonlib/settings';
import {upsertRemoteConfigurationInPlace} from '@vrtmrz/livesync-commonlib/remote-configurations';
import {FREE_RELAY_BASE,FREE_SIGNAL_URL,isFreeRelayConnection as isFreeRelay,runtimeRelaySettings,freeRelayDiscoveryRecoveryDue} from './free-relay-settings.mjs';

/** Access tokens stay in the local plugin directory, outside synchronised settings. */
export class FreeRelay {
  busy=false;
  refreshing:Promise<any>|null=null;
  sessionWrites:Promise<any>=Promise.resolve();
  renewing:Promise<void>|null=null;
  nextRenewAt=0;
  noPeersSince=0;
  lastError="";
  constructor(private plugin:any) {}
  get sessionPath(){return this.plugin.pilotDirectory+'/free-relay-session.json';}
  async session(){
    const adapter=this.plugin.app.vault.adapter;
    if(!await adapter.exists(this.sessionPath))return null;
    try {const value=JSON.parse(await adapter.read(this.sessionPath));if(!value.accessToken||!/^[a-f0-9]{32}$/.test(value.group))throw Error();return value;}
    catch {throw Error('Не удалось прочитать подключение Free. Войдите заново.');}
  }
  async writeSession(value:any,guard?:()=>Promise<any>){
    const write=this.sessionWrites.then(async()=>{
      const newer=await guard?.();if(newer)return newer;
      try{await this.plugin.app.vault.adapter.write(this.sessionPath,JSON.stringify(value));}
      catch{throw Error('Не удалось сохранить подключение ArcaLink. Проверьте доступ к папке хранилища и повторите попытку.');}
      return value;
    });
    this.sessionWrites=write.catch(()=>{});return write;
  }
  async refresh(session:any){
    const sameAccount=(a:any,b:any)=>a?.deviceId===b?.deviceId&&a?.email===b?.email&&a?.group===b?.group;
    const readCurrent=async()=>{
      const common=await this.session();if(common)return common;
      const saved=await this.plugin.unifiedVault?.saved();
      return saved?.auth?{...saved.auth,group:saved.auth.group||saved.workspaceId||session.group}:null;
    };
    const current=await readCurrent();
    if(current){
      if(!sameAccount(current,session))throw Error('Подключение ArcaLink изменилось. Повторите действие.');
      if(current.accessToken!==session.accessToken||current.refreshToken!==session.refreshToken)return current;
      session=current;
    }
    if(!session.refreshToken)throw this.authError(401);
    const newerSession=async()=>{
      const latest=await readCurrent();
      if(latest){
        if(!sameAccount(latest,session))throw Error('Подключение ArcaLink изменилось. Повторите действие.');
        if(latest.accessToken!==session.accessToken||latest.refreshToken!==session.refreshToken)return latest;
      }else if(current)throw Error('Подключение ArcaLink изменилось. Повторите действие.');
      return null;
    };
    if(!this.refreshing)this.refreshing=(async()=>{
      let response:any;
      try{response=await requestUrl({url:'https://arcalink.ru/auth/refresh',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refreshToken,access_token:session.accessToken,rotate_refresh_token:false}),throw:false});}
      catch{throw this.authError(503);}
      const newer=await newerSession();if(newer)return newer;
      if(response.status!==200)throw this.authError(response.status);
      let data:any;try{data=response.json;}catch{throw this.authError(503);}
      if(typeof data?.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token)throw this.authError(503);
      const next={...session,accessToken:data.access_token,refreshToken:data.refresh_token,accessExpiresAt:Date.parse(data.auth_session?.access_expires_at||'')||Date.now()+50*60*1000};
      return this.writeSession(next,newerSession);
    })().finally(()=>{this.refreshing=null;});
    const result=await this.refreshing;
    if(!sameAccount(result,session))throw Error('Подключение ArcaLink изменилось. Повторите действие.');
    return result;
  }
  authError(status:number){return Object.assign(Error(status===401?'Сессия ArcaLink завершена. Войдите снова в настройках. Локальные заметки сохранены.':status===403?'Нет доступа к аккаунту ArcaLink. Проверьте аккаунт в личном кабинете.':status===429?'ArcaLink временно ограничил запросы. Подождите немного.':'Не удалось связаться с ArcaLink. Повторим подключение автоматически. Локальные заметки сохранены.'),{status});}
  async credentials(session:any,retry=true):Promise<{room:string;relayUrl:string;turnUrls:string[];username:string;credential:string;expiresAt:number}>{
    let response:any;
    try{response=await requestUrl({url:FREE_RELAY_BASE+'/credentials',method:'POST',headers:{Authorization:'Bearer '+session.accessToken,'Content-Type':'application/json'},body:JSON.stringify({group:session.group}),throw:false});}
    catch{throw this.authError(503);}
    if(response.status===401&&retry&&session.refreshToken)return this.credentials(await this.refresh(session),false);
    if(response.status===401||response.status===403)throw this.authError(response.status);
    if(response.status!==200)throw Error(response.status===429?'Лимит подключений Free. Закройте лишний клиент и повторите попытку.':'Сервер Free временно недоступен');
    return response.json;
  }
  async prepare(settings:any,signal:AbortSignal){
    const session=await this.session();if(!session)throw Error('Войдите в Free');
    const credentials=await this.credentials(session);if(signal.aborted)throw Error('Подключение Free отменено');
    return runtimeRelaySettings(settings,credentials);
  }
  async connect(email:string,password:string,group:string,passphrase:string){
    if(this.busy)throw Error('Подключение выполняется');
    const services=this.plugin.core.services,settings=services.setting.currentSettings();
    if(settings.isConfigured&&!isFreeRelay(settings))throw Error('Для теста Free используйте отдельное локальное хранилище. Текущее облачное подключение сохранено.');
    if(!/^[a-f0-9]{32}$/.test(group)||passphrase.length<16)throw Error('Укажите код группы из 32 hex-символов и парольную фразу от 16 символов');
    if(await this.plugin.workspaces.pendingMerge()||await this.plugin.workspaces.pendingMigration())throw Error('Сначала завершите перенос хранилища');
    this.busy=true;
    try {
      let old:any=null;
      try {old=await this.session();}catch {/* Explicit login can repair a damaged local session. */}
      const response=await requestUrl({url:'https://arcalink.ru/auth/password/login',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.trim().toLowerCase(),password,device_name:'Free '+this.plugin.app.vault.getName(),platform:Platform.isMobile?'mobile':'desktop',app_version:accountClientVersion(this.plugin.manifest),...(old?.email===email.trim().toLowerCase()?{device_id:old.deviceId}:{})}),throw:false});
      if(![200,201].includes(response.status)||!response.json.access_token)throw Error('Не удалось войти в ArcaLink');
      const session={email:email.trim().toLowerCase(),accessToken:response.json.access_token,refreshToken:response.json.refresh_token,accessExpiresAt:Date.parse(response.json.auth_session?.access_expires_at||'')||Date.now()+50*60*1000,deviceId:response.json.device.id,group};
      const credentials=await this.credentials(session);
      const next={...(settings.isConfigured?settings:createNewVaultSettings()),isConfigured:true,remoteType:'ONLY_P2P',
        liveSync:false,periodicReplication:false,syncOnSave:false,syncOnStart:false,syncOnFileOpen:false,
        P2P_Enabled:true,P2P_relays:FREE_SIGNAL_URL,P2P_roomID:credentials.room,P2P_passphrase:passphrase,
        P2P_DevicePeerName:this.plugin.app.vault.getName()+' '+session.deviceId.slice(-6),P2P_AppID:'self-hosted-livesync',
        P2P_AutoStart:true,P2P_AutoBroadcast:true,P2P_AutoAccepting:0,P2P_managedType:'',P2P_managedId:'',P2P_managedToken:'',
        P2P_turnServers:credentials.turnUrls.join(','),P2P_turnUsername:'',P2P_turnCredential:'',P2P_connectionPath:'relay',P2P_useDiagRTC:true};
      runtimeRelaySettings(next,credentials);
      upsertRemoteConfigurationInPlace(next as any,'p2p',{id:'arcalink-free',name:'ArcaLink Free',activate:true,activateForP2P:true});
      await this.writeSession(session);
      services.config.setSmallConfig('p2p_device_name',next.P2P_DevicePeerName);
      await services.setting.applyPartial(next,true);
      // Settings are saved; the user decides when to start the new app lifecycle.
      await this.plugin.core.services.appLifecycle.askRestart("Connection settings are saved. Restart Obsidian to start syncing. Restart now?");

    } finally {this.busy=false;}
  }
  async renew(force=false){
    if(this.busy||!isFreeRelay(this.plugin.core.services.setting.currentSettings())||(!force&&!this.plugin.core.services.setting.currentSettings().P2P_AutoStart))return;
    if(this.renewing)return this.renewing;
    if(!force&&Date.now()<this.nextRenewAt)return;
    this.nextRenewAt=Date.now()+15000;
    this.renewing=(async()=>{
      const peers=this.plugin.arcalinkP2P?.peerDirectory.getPeers()||[];
      if(peers.length)this.noPeersSince=0;else this.noPeersSince ||= Date.now();
      if(freeRelayDiscoveryRecoveryDue(this.plugin.core.services.setting.currentSettings(),peers.length,this.noPeersSince)){this.noPeersSince=Date.now();await this.plugin.arcalinkP2P?.transportLifecycle.disconnect();}
      await this.plugin.arcalinkP2P?.transportLifecycle.connect();
      if(!this.plugin.arcalinkP2P?.transportLifecycle.isConnected)throw Error('Free: сигнальное соединение не подтверждено');
      this.lastError='';
    })().catch(error=>{this.lastError=error.message;throw error;}).finally(()=>{this.renewing=null;});
    return this.renewing;
  }

  render(el:HTMLElement){
    el.createEl('p',{text:'Free: файлы передаются через ArcaLink без облачной копии. Оба клиента должны быть открыты. На телефоне оставьте Obsidian на экране. Для испытаний используйте отдельный vault.'});
    let email='',password='',group='',phrase='';
    new Setting(el).setName('Почта ArcaLink').addText(t=>t.onChange(v=>email=v));
    new Setting(el).setName('Пароль аккаунта').addText(t=>{t.inputEl.type='password';t.onChange(v=>password=v);});
    const groupSetting=new Setting(el).setName('Код группы').setDesc('Одинаковый на двух устройствах. Скопируйте после генерации.');
    let groupInput:any;
    groupSetting.addText(t=>{groupInput=t;t.onChange(v=>group=v.trim());}).addButton(b=>b.setButtonText('Создать код').onClick(()=>{group=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');groupInput.setValue(group);}));
    new Setting(el).setName('Парольная фраза группы').setDesc('Не менее 16 символов, одинаковая на обоих устройствах.').addText(t=>{t.inputEl.type='password';t.onChange(v=>phrase=v);});
    new Setting(el).setName('Подключение Free').addButton(b=>b.setButtonText('Войти и подключить').onClick(async()=>{b.setDisabled(true);try{await this.connect(email,password,group,phrase);}catch(e:any){new Notice(e.message);}finally{b.setDisabled(false);}}));
    new Setting(el).setName('Обмен с устройством').setDesc('В панели P2P подтвердите ожидаемое устройство и выполните Replicate now. Настройте Follow changes для автоматического получения.').addButton(b=>b.setButtonText('Открыть устройства').onClick(()=>this.plugin.app.commands.executeCommandById(this.plugin.manifest.id+':open-p2p-server-status')));
    const status=el.createEl('p');
    const update=()=>{const peers=this.plugin.arcalinkP2P?.peerDirectory.getPeers()||[];status.setText(!isFreeRelay(this.plugin.core.services.setting.currentSettings())?'Free не подключён':!this.plugin.arcalinkP2P?.transportLifecycle.isConnected?'Free: подключение отсутствует':!peers.length?'Free: ожидаем второе устройство':'Free: второе устройство подключено. Завершение обмена проверяйте в панели устройств.');};update();
    const timer=window.setInterval(()=>{if(!el.isConnected){window.clearInterval(timer);return;}update();},1000);this.plugin.register(()=>window.clearInterval(timer));
  }
}
