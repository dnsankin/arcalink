export const FREE_RELAY_BASE='https://arcalink.ru/sync-lab/free';
export const FREE_SIGNAL_URL='wss://arcalink.ru/sync-lab/free/signal';
export function isFreeRelay(settings) {
  return settings?.remoteType==='ONLY_P2P' && settings.P2P_relays===FREE_SIGNAL_URL;
}
export function isFreeRelayConnection(settings) {
  const url=settings?.P2P_relays;
  return settings?.remoteType==='ONLY_P2P' && typeof url==='string' &&
    (url===FREE_SIGNAL_URL || url.startsWith(FREE_SIGNAL_URL+'?ticket='));
}
export function freeRelayRpcOptions(settings, defaults) {
  return isFreeRelayConnection(settings)?{...defaults,chunkMissingRetryMs:5000,deferChunkRetriesUntilSent:true}:defaults;
}
export function freeRelayRpcTimeout(settings, timeout) {
  const free=isFreeRelayConnection(settings);
  // Zero is upstream's explicit operation-without-timer mode. Its caller owns
  // the cancellation signal; do not turn whole-vault sync into a 3-minute RPC.
  return free && timeout>0 ? Math.max(timeout,300000) : timeout;
}
export function runtimeRelaySettings(settings, credentials, now=Date.now()) {
  const relay=new URL(credentials.relayUrl);
  if(relay.origin!=='wss://arcalink.ru'||relay.pathname!=='/sync-lab/free/signal'||!relay.searchParams.get('ticket')||
    credentials.room!==settings.P2P_roomID||credentials.connectionPath!=='relay-only'||credentials.serverStorage!==false||
    !Number.isFinite(credentials.expiresAt)||credentials.expiresAt<=now+60000||
    !Array.isArray(credentials.turnUrls)||!credentials.turnUrls.length||
    credentials.turnUrls.some(url=>!/^turns?:arcalink\.ru:(3478|5349)(\?transport=(udp|tcp))?$/.test(url))||
    typeof credentials.username!=='string'||!credentials.username||typeof credentials.credential!=='string'||!credentials.credential) throw Error('Некорректные параметры Free от сервера');
  return {...settings,P2P_connectionPath:'relay',P2P_relays:credentials.relayUrl,
    P2P_iceServers:[{urls:credentials.turnUrls,username:credentials.username,credential:credentials.credential}],
    P2P_iceServersExpiresAt:credentials.expiresAt};
}

// A room object survives a failed signalling socket. It is not connection proof.
export function freeRelaySignalIsOpen(settings, sockets) {
  return !isFreeRelayConnection(settings) || sockets[settings.P2P_relays]?.readyState===1;
}
export function freeRelayCredentialsUsable(settings, now=Date.now()) {
  return !isFreeRelayConnection(settings) || Number.isFinite(settings.P2P_iceServersExpiresAt) && settings.P2P_iceServersExpiresAt>now+120000;
}
export async function waitForFreeRelaySignal(settings, getSockets, isCurrent, options={}) {
  if(!isFreeRelayConnection(settings))return;
  const now=options.now||Date.now, pause=options.pause||(ms=>new Promise(resolve=>setTimeout(resolve,ms))), deadline=now()+(options.timeoutMs||15000);
  while(isCurrent() && now()<deadline) {
    const socket=getSockets()[settings.P2P_relays];
    if(socket?.readyState===1)return;
    if(socket?.readyState===2||socket?.readyState===3)throw Error('Сигнальное соединение Free закрыто');
    await pause(50);
  }
  throw Error(isCurrent()?'Сервер Free не подтвердил сигнальное соединение':'Подключение Free отменено');
}

export function freeRelayDiscoveryRecoveryDue(settings, peerCount, missingSince, now=Date.now()) {
  return isFreeRelayConnection(settings) && typeof settings.P2P_AutoWatchPeers==='string' && settings.P2P_AutoWatchPeers.trim().length>0 && peerCount===0 && missingSince>0 && now-missingSince>=45000;
}
