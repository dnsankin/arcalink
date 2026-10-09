import {Notice,requestUrl,Setting} from 'obsidian';
import {isFreeRelayConnection as isFreeRelay,FREE_SIGNAL_URL} from './free-relay-settings.mjs';
import {upsertRemoteConfigurationInPlace} from '@vrtmrz/livesync-commonlib/remote-configurations';
import {accountClientVersion,announceClientVersion} from './client-version.mjs';
const PAUSE={liveSync:false,periodicReplication:false,syncOnSave:false,syncOnEditorSave:false,syncOnStart:false,syncOnFileOpen:false,syncAfterMerge:false};
const CLOUD_KEYS=['remoteType','liveSync','periodicReplication','syncOnSave','syncOnEditorSave','syncOnStart','syncOnFileOpen','syncAfterMerge'];
export class UnifiedVault {
  busy=false;state:any=null;lastWarning='';
  announcedVersion='';
  constructor(private plugin:any){}
  get path(){return this.plugin.pilotDirectory+'/unified-vault.json';}
  get base(){return this.plugin.manifest.id==='arcalink-free-lab'?'https://arcalink.ru/sync-lab/unified/api':'https://arcalink.ru/sync/api';}
  async saved(){try{return JSON.parse(await this.plugin.app.vault.adapter.read(this.path));}catch{return null;}}
  async save(data:any){await this.plugin.app.vault.adapter.write(this.path,JSON.stringify(data));}
  async poll(){
    if(this.busy||!navigator.onLine)return;
    const p=this.plugin,s=p.core.services.setting.currentSettings();if(!s?.isConfigured||p.workspaces.busy||await p.workspaces.pendingMerge()||await p.workspaces.pendingMigration())return;
    this.busy=true;
    try{
      let saved=await this.saved();const workspace=await p.workspaces.session();let free=await p.freeRelay.session()||saved?.auth;
      const id=saved?.workspaceId||workspace.workspaceId;
      // A cloud-only login has no common transport file yet. Bind its refreshed
      // account session to the existing vault before FreeRelay persists it.
      if(free?.refreshToken&&!free.group){if(!/^[a-f0-9]{32}$/.test(id))throw Error('Не удалось определить хранилище. Обновите подключение в настройках.');free={...free,group:id};}
      let auth:string;
      if(free?.refreshToken){if(free.accessExpiresAt<=Date.now()+120000)free=await p.freeRelay.refresh(free);auth='Bearer '+free.accessToken;saved={...saved,auth:free};}
      else auth='Basic '+btoa(s.couchDB_USER+':'+s.couchDB_PASSWORD);
      const versionKey=free?.deviceId+':'+accountClientVersion(p.manifest);
      if(this.announcedVersion!==versionKey&&await announceClientVersion(requestUrl,p.manifest,free))this.announcedVersion=versionKey;
      const response=await requestUrl({url:this.base+'/workspaces/state',method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(id?{id}:{}),throw:false});
      if(response.status!==200)return;
      const state=response.json;if(state.policy_version!==1||!state.relay_free_enabled)return;
      if(!/^[a-f0-9]{32}$/.test(state.workspace_id)||(id&&state.workspace_id!==id)||!['cloud','relay'].includes(state.sync_mode)||typeof state.relay_passphrase!=='string'||state.relay_passphrase.length<16||!/^[a-f0-9]{32}$/.test(state.relay_group))throw Error('Некорректная привязка хранилища');
      // Refresh the gateway binding too: account token rotation invalidates its
      // previous token even while the transport remains cloud.
      if(state.sync_mode==='cloud'&&!isFreeRelay(s)&&auth.startsWith('Bearer ')){
        const bound=await requestUrl({url:this.base+'/workspaces/connect',method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({id:state.workspace_id}),throw:false});
        if(bound.status!==200)throw Error('Не удалось обновить авторизацию облачного хранилища');
        if(bound.json.user!==s.couchDB_USER||bound.json.password!==s.couchDB_PASSWORD||bound.json.database!==s.couchDB_DBNAME)throw Error('Привязка облачного клиента изменилась');
      }
      this.state=state;
      saved={...saved,workspaceId:state.workspace_id,title:state.title};
      if(state.sync_mode==='relay'&&(!isFreeRelay(s)||free?.group!==state.relay_group)){
        if(!isFreeRelay(s))saved.cloud=Object.fromEntries(CLOUD_KEYS.map(key=>[key,s[key]]));saved.transition='to-relay';await this.save(saved);
        // The gateway identity is carried into Free; never create a new device.
        const session=free||saved.auth||state.account_session;
        if(!session?.accessToken)throw Error('Обновите вход в аккаунт для автоматического обмена Free. Настройки и заметки сохранены.');
        session.group=state.relay_group;await p.app.vault.adapter.write(p.freeRelay.sessionPath,JSON.stringify(session));
        const credentials=await p.freeRelay.credentials(session);
        const next={...s,...PAUSE,remoteType:'ONLY_P2P',P2P_Enabled:true,P2P_AutoStart:saved.connectionEnabled!==false,P2P_AutoBroadcast:true,P2P_AutoAccepting:1,P2P_AutoSyncPeers:s.P2P_AutoSyncPeers||(s.liveSync?'~.*':''),P2P_AutoWatchPeers:s.P2P_AutoWatchPeers||(s.liveSync?'~.*':''),P2P_relays:FREE_SIGNAL_URL,P2P_roomID:credentials.room,P2P_passphrase:state.relay_passphrase,P2P_AppID:'self-hosted-livesync',P2P_connectionPath:'relay'};
        upsertRemoteConfigurationInPlace(next as any,'p2p',{id:'arcalink-free',name:state.title,activate:true,activateForP2P:true});
        await p.core.services.setting.applyPartial(next,true);await p.core.services.control.applySettings();saved.transition=null;await this.save(saved);
      }else if(state.sync_mode==='cloud'&&isFreeRelay(s)){
        saved.transition='to-cloud';await this.save(saved);
        const r=await requestUrl({url:this.base+'/workspaces/connect',method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({id:state.workspace_id}),throw:false});if(r.status!==200)throw Error('Облачное подключение пока не восстановлено. Free и локальные заметки сохранены.');
        const next={...s,...(saved.cloud||{liveSync:true,syncOnSave:true,syncOnStart:true}),...(saved.connectionEnabled===false?PAUSE:{}),remoteType:'',couchDB_URI:r.json.url.replace(/\/$/,''),couchDB_DBNAME:r.json.database,couchDB_USER:r.json.user,couchDB_PASSWORD:r.json.password,P2P_AutoStart:false};
        await p.workspaces.checkDestinationKey(next);
        upsertRemoteConfigurationInPlace(next as any,'couchdb',{id:'arcalink-pilot',name:state.title,activate:true});
        await p.arcalinkP2P.transportLifecycle.disconnect();await p.core.services.setting.applyPartial(next,true);await p.core.services.control.applySettings();saved.transition=null;await this.save(saved);
      }else {
        if(saved.transition){await p.core.services.control.applySettings();saved.transition=null;}
        await this.save(saved);
      }
      if(state.sync_mode==='cloud')await p.initializeCloudFeatures();
      const deadlines=[state.cloud_state==='retained'?state.cloud_retained_until:null,state.collaboration_state==='retained'?state.collaboration_retained_until:null].filter(Boolean).sort();
      const warning=state.sync_mode==='relay'?(deadlines[0]||''):'';
      if(state.sync_mode==='cloud'&&state.paid_until){const left=Date.parse(state.paid_until)-Date.now();const key='expires:'+state.paid_until+':'+Math.ceil(left/86400000);if(left>0&&left<=3*86400000&&saved.notified!==key){saved.notified=key;await this.save(saved);new Notice('Оплата закончится '+new Date(state.paid_until).toLocaleString()+'. Затем включится Free; облачная копия хранится ещё 14 суток. Для Free оба устройства должны быть открыты.',20000);}}
      if(warning&&saved.notified!==warning){saved.notified=warning;await this.save(saved);new Notice('Вы перешли на Free. Оба устройства должны быть открыты. Облачная копия будет удалена '+new Date(warning).toLocaleString()+'. Локальные заметки сохранятся. Продлите тариф до этой даты.',20000);}
    }catch(e:any){new Notice(e.message,10000);}finally{this.busy=false;}
  }
  async setConnectionPreference(value:boolean){const saved=await this.saved();await this.save({...saved,connectionEnabled:value});}
  render(el:HTMLElement){
    const tariff=new Setting(el).setName('Тариф и способ синхронизации');
    const retention=new Setting(el).setName('Облачная копия');
    new Setting(el).setName('Срок хранения серверных копий').setDesc('После перехода на Free серверные копии хранятся 14 суток, включая совместные заметки и общие папки. Затем они удаляются. Локальные файлы и настройки сохраняются.');
    const update=()=>{const state=this.state,s=this.plugin.core.services.setting.currentSettings();tariff.setDesc(state?(state.plan==='begin'?'Begin':state.plan==='free'?'Free':'Pro')+' — '+(state.sync_mode==='relay'?'обмен между двумя открытыми устройствами':'серверное хранилище')+(state.paid_until&&state.sync_mode==='cloud'?'. Оплачено до '+new Date(state.paid_until).toLocaleString():''):isFreeRelay(s)?'Free — обмен между двумя открытыми устройствами':'Проверяем тариф');retention.setDesc(state?.cloud_state==='retained'?'Облачная копия будет удалена '+new Date(state.cloud_retained_until).toLocaleString()+'. Продление до этой даты сохранит её. Локальные заметки не удаляются.':state?.cloud_state==='purged'?'Облачная копия удалена. Локальные заметки и настройки сохранены.':isFreeRelay(s)?'Облачная копия не используется. После окончания оплаты она хранится 14 суток.':'После окончания оплаты включится Free. Облачная копия хранится 14 суток, затем удаляется; локальные заметки сохраняются.');};
    tariff.addButton(b=>b.setButtonText('Продлить тариф').onClick(()=>window.open('https://arcalink.ru/cabinet','_blank')));
    update();const timer=window.setInterval(()=>{if(!el.isConnected){window.clearInterval(timer);return;}update();},1000);this.plugin.register(()=>window.clearInterval(timer));
  }
  async rememberAuth(bundle:any,email:string){const saved=await this.saved();await this.save({...saved,auth:{email,deviceId:bundle.device.id,accessToken:bundle.access_token,refreshToken:bundle.refresh_token,accessExpiresAt:Date.parse(bundle.auth_session?.access_expires_at)}});}
}
