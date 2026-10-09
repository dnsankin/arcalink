import {Notice,Setting} from 'obsidian';
import {eventHub} from '@/common/events';
import {EVENT_SERVER_STATUS,EVENT_P2P_REPLICATOR_STATUS} from '@vrtmrz/livesync-commonlib/compat/replication/trystero/TrysteroReplicatorP2PServer';
import {isFreeRelayConnection as isFreeRelay} from './free-relay-settings.mjs';

/** Settings-only device controls. Wire identities and counters stay internal. */
export class VaultControls {
  constructor(private plugin:any){}
  render(el:HTMLElement){
    if(!isFreeRelay(this.plugin.core.services.setting.currentSettings()))return;
    let server:any,activity:any,busy=false,disposed=false,lastError='';
    const p=this.plugin,p2p=p.arcalinkP2P;
    const matches=(pattern:string,name:string)=>{try{return new RegExp(pattern.slice(1)).test(name);}catch{return false;}};
    new Setting(el).setName('Синхронизация Free').setHeading();
    el.createEl('p',{text:'Без облачной копии: два устройства должны быть открыты и подключены к интернету. Локальные заметки сохраняются при отсутствии связи.'});
    const status=new Setting(el).setName('Статус');
    const connection=new Setting(el).setName('Подключение').addButton(b=>b.setButtonText('Подключить').onClick(async()=>{try{await p.unifiedVault.setConnectionPreference(true);await p.core.services.setting.applyPartial({P2P_AutoStart:true},true);await p.freeRelay.renew(true);lastError='';}catch(e:any){lastError=e.message;new Notice(lastError);}update();})).addButton(b=>b.setButtonText('Отключить').onClick(async()=>{try{await p.unifiedVault.setConnectionPreference(false);await p.core.services.setting.applyPartial({P2P_AutoStart:false},true);await p2p.transportLifecycle.disconnect();}catch(e:any){new Notice(e.message);}update();}));
    const devices=el.createDiv();let signature='';
    const execute=async(fn:()=>Promise<any>)=>{if(busy)return;busy=true;update();try{await fn();lastError='';}catch(e:any){lastError=e.message;new Notice(lastError);}finally{busy=false;p2p?.diagnostics.requestStatus();update();}};
    const update=()=>{
      if(disposed)return;
      const peers=p2p?.peerDirectory.getPeers()||[],active=busy||activity?.replicatingFrom?.length||activity?.replicatingTo?.length;
      status.setDesc(lastError?'Обмен приостановлен: '+lastError:!p2p?.transportLifecycle.isConnected?'Нет соединения':!peers.length?'Ожидаем второе устройство':active?'Идёт обмен':'Устройство подключено');
      connection.setDesc(p2p?.transportLifecycle.isConnected?'Есть связь с сервером ArcaLink':'Подключение отсутствует');
      const snapshot=(server?.knownAdvertisements||[]).filter((x:any)=>peers.some((y:any)=>y.peerId===x.peerId));
      const next=JSON.stringify([snapshot.map((x:any)=>[x.peerId,x.name,x.isAccepted,x.isTemporaryAccepted]),activity?.watchingPeers,busy]);if(next===signature)return;signature=next;devices.empty();
      for(const peer of snapshot){
        const label=peer.name.replace(/\s[0-9a-f]{6}$/i,'');
        const accepted=peer.isAccepted||peer.isTemporaryAccepted||(peer.isAccepted!==false&&p.core.services.setting.currentSettings().P2P_AutoAccepting===1);
        const row=new Setting(devices).setName(label).setDesc(accepted?'Доверенное устройство':peer.isAccepted===false?'Доступ отозван':'Требуется подтверждение');
        row.nameEl.setAttribute('data-arcalink-user-content','');
        row.addButton(b=>b.setButtonText(accepted?'Отозвать':'Подтвердить').setDisabled(busy).onClick(()=>void execute(async()=>{if(accepted)await p2p.peerAdmission.makeDecision({peerId:peer.peerId,name:peer.name,decision:false,isTemporary:false});else await p2p.peerAdmission.makeDecision({peerId:peer.peerId,name:peer.name,decision:true,isTemporary:false});})));
        if(!accepted)continue;
        row.addButton(b=>b.setButtonText('Синхронизировать').setDisabled(busy).onClick(()=>void execute(async()=>{const result=await p2p.targetedTransfer.synchroniseWithPeer(peer.peerId,true);if(!result.ok)throw Error(result.status==='cancelled'?'Обмен отменён':'Не удалось завершить обмен');new Notice('Обмен с «'+label+'» завершён');})));
        const s=p.core.services.setting.currentSettings(),names=(s.P2P_AutoWatchPeers||'').split(',').filter(Boolean);
        new Setting(devices).setName('Автоматический обмен с «'+label+'»').addToggle(t=>t.setValue(names.includes(peer.name)||names.some((x:string)=>x.startsWith('~')&&matches(x,peer.name))).setDisabled(busy).onChange(value=>void execute(async()=>{
          const current=p.core.services.setting.currentSettings(),patch:any={P2P_AutoBroadcast:true};
          for(const key of ['P2P_AutoWatchPeers','P2P_AutoSyncPeers','P2P_SyncOnReplication']){const items=(current[key]||'').split(',').map((x:string)=>x.trim()).flatMap((x:string)=>x.startsWith('~')?(p2p.peerDirectory.getPeers()||[]).filter((other:any)=>matches(x,other.name)).map((other:any)=>other.name):[x]).filter((x:string)=>x&&x!==peer.name);if(value)items.push(peer.name);patch[key]=items.join(',');}
          await p.core.services.setting.applyPartial(patch,true);p2p.changeRelay.enableBroadcastChanges();if(value)p2p.changeRelay.watchPeer(peer.peerId);else p2p.changeRelay.unwatchPeer(peer.peerId);
        })));
      }
    };
    const off=[eventHub.onEvent(EVENT_SERVER_STATUS,(value:any)=>{server=value;update();}),eventHub.onEvent(EVENT_P2P_REPLICATOR_STATUS,(value:any)=>{activity=value;update();})];
    const cleanup=()=>{if(disposed)return;disposed=true;off.forEach(fn=>fn());window.clearInterval(timer);};
    const timer=window.setInterval(()=>{if(!el.isConnected){cleanup();return;}update();p2p?.diagnostics.requestStatus();},1000);p.register(cleanup);update();p2p?.diagnostics.requestStatus();
  }
}
