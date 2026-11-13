import {createPeerActionChannel} from './companion-peer-action-channel.mjs';
import {openPeerActionClient} from './companion-peer-action-client.mjs';
import {isFreeRelayConnection,freeRelayCredentialsUsable,waitForFreeRelaySignal} from './free-relay-settings.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** Action-only room. The caller provides the maintained, patched Trystero exports. */
export async function openPeerActionRoom({settings,grant,signal,deadlineAt,RpcRoom,joinRoom,selfId,getRelaySockets,generateJoinRoomOptions,subscribePeers}){
 if(!settings||!grant||!signal||signal.aborted||!Number.isFinite(deadlineAt)||deadlineAt<=Date.now()||!isFreeRelayConnection(settings)||!freeRelayCredentialsUsable(settings)||typeof joinRoom!=='function'||typeof selfId!=='string'||typeof getRelaySockets!=='function'||typeof generateJoinRoomOptions!=='function'||typeof subscribePeers!=='function')throw fail('action-peer-unavailable');
 settings=structuredClone(settings);settings.P2P_turnServers=typeof settings.P2P_turnServers==='string'?settings.P2P_turnServers:'';grant=structuredClone(grant);
 let closed=false,channel,unsubscribe=()=>{};const room=joinRoom(generateJoinRoomOptions(settings),settings.P2P_roomID,{handshakeTimeoutMs:30000,onJoinError:()=>{}});
 const close=async()=>{if(closed)return;closed=true;signal.removeEventListener('abort',aborted);unsubscribe();channel?.close();await room.leave();};
 const aborted=()=>{void close().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  await waitForFreeRelaySignal(settings,getRelaySockets,()=>!closed&&!signal.aborted,{timeoutMs:Math.max(1,Math.min(15000,deadlineAt-Date.now()))});
  if(closed||signal.aborted)throw fail('action-peer-unavailable');
  const peers=new Set(Object.keys(room.getPeers()));unsubscribe=subscribePeers(room,{onJoin:id=>peers.add(id),onLeave:id=>peers.delete(id)});
  channel=createPeerActionChannel({room,RpcRoom,subscribePeers});
  return {async connect(){
   const tried=new Map();while(!closed&&!signal.aborted&&Date.now()<deadlineAt-1000){
    for(const peerId of [...peers].sort().slice(0,8)){if((tried.get(peerId)||0)>Date.now())continue;tried.set(peerId,Date.now()+5000);
     try{return await openPeerActionClient({channel,peerId,sourcePeerId:selfId,grant,signal,timeoutMs:Math.max(1,Math.min(5000,deadlineAt-Date.now()))});}catch{if(closed||signal.aborted)throw fail('action-peer-unavailable');}
    }
    await new Promise(resolve=>setTimeout(resolve,250));
   }throw fail('action-peer-unavailable');
  },close};
 }catch(error){await close().catch(()=>{});throw error;}
}
