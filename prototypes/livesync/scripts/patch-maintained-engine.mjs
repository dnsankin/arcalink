import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {patchIdbMemory} from './patch-idb-memory.mjs';
import {patchLargeContent,patchDecodedBinary} from './patch-large-content.mjs';
import {patchReplicationBusy} from './patch-replication.mjs';
import {patchTicketRelayLifecycle,patchFreeChunkRetries,patchTicketedPeerCleanup,patchTicketedRtcRelease,patchTicketedFreshJoin} from './patch-free-relay.mjs';

/** Identical maintained protocol patches shared by plugin and autonomous host. */
export async function patchMaintainedEngine(source,{foldersLab=false}={}) {
const replicatorPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/replication/couchdb/LiveSyncReplicator.js');
const replicatorSource=await readFile(replicatorPath,'utf8');
const seedCacheKey='const server = `${setting.couchDB_URI.replace(/\\/+$/, "")}/${setting.couchDB_DBNAME}`;';
if(replicatorSource.split(seedCacheKey).length!==2)throw Error('Unexpected upstream sync parameters cache key');
const seedHelperImport=path.relative(path.dirname(replicatorPath),path.join(source,'src/sync-parameters.mjs')).split(path.sep).join('/');
await writeFile(replicatorPath,`import {syncParametersCacheKey} from ${JSON.stringify(seedHelperImport)};\n`+patchReplicationBusy(replicatorSource).replace(seedCacheKey,'const server = await syncParametersCacheKey(setting);'));
// Trystero otherwise warms 20 offers, allocating TURN sockets for every local
// interface before a single peer connects. Forced relay needs a smaller pool.
const trysteroCore=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/node_modules/@trystero-p2p/core/dist');
const socketUtilsPath=path.join(trysteroCore,'utils.mjs');
const nostrPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/node_modules/@trystero-p2p/nostr/dist/index.mjs');
const ticketLifecycle=patchTicketRelayLifecycle(await readFile(socketUtilsPath,'utf8'),await readFile(nostrPath,'utf8'));
await writeFile(socketUtilsPath,ticketLifecycle.utils);
await writeFile(nostrPath,ticketLifecycle.nostr);
const nativePeerPath=path.join(trysteroCore,'peer.mjs');
const nativePeerSource=await readFile(nativePeerPath,'utf8');
await writeFile(nativePeerPath+'.upstream',nativePeerSource); // Executable regression baseline.
await writeFile(nativePeerPath,patchTicketedRtcRelease(nativePeerSource));
const offerPath=path.join(trysteroCore,'offer-pool.mjs'),strategyPath=path.join(trysteroCore,'strategy.mjs');
const offerSource=await readFile(offerPath,'utf8'),strategySource=await readFile(strategyPath,'utf8');
if(offerSource.split('constructor(makeOffer) {').length!==2||offerSource.split('alloc(poolSize, this.makeOffer)').length!==2||strategySource.split('new OfferPool(makeOffer)').length!==2)throw Error('Unexpected Trystero offer pool');
await writeFile(offerPath,offerSource.replace('constructor(makeOffer) {','constructor(makeOffer, size = poolSize) {\n        this.size = size;').replace('alloc(poolSize, this.makeOffer)','alloc(this.size, this.makeOffer)'));
await writeFile(strategyPath+'.upstream',strategySource); // Executable initialization baseline.
await writeFile(strategyPath,patchTicketedFreshJoin(patchTicketedPeerCleanup(strategySource)).replace('new OfferPool(makeOffer)','new OfferPool(makeOffer, config.rtcConfig?.iceTransportPolicy === "relay" ? 2 : 20)'));
const roomOwnerPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/replication/trystero/P2PRoomSessionOwner.js');
// A measured external TURN transfer of 3 MiB took 84 seconds. Keep cancellation
// signals and bounded deadlines, but allow Free bulk RPCs to outlive 30 seconds.
const rpcRoomPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/rpc/RpcRoom.js');
await writeFile(rpcRoomPath,patchFreeChunkRetries(await readFile(rpcRoomPath,'utf8')));
const rpcTransportPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/rpc/transports/TrysteroTransport.js');
const rpcTransport=await readFile(rpcTransportPath,'utf8');
const optionsMarker='    ...TRYSTERO_RPC_DEFAULTS,';
if(rpcTransport.split(optionsMarker).length!==2)throw Error('Unexpected Trystero RPC options');
const optionsHelperImport=path.relative(path.dirname(rpcTransportPath),path.join(source,'src/free-relay-settings.mjs')).split(path.sep).join('/');
await writeFile(rpcTransportPath,`import {freeRelayRpcOptions} from ${JSON.stringify(optionsHelperImport)};\n`+rpcTransport.replace(optionsMarker,'    ...freeRelayRpcOptions(settings, TRYSTERO_RPC_DEFAULTS),'));
const rpcClientPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/replication/trystero/TrysteroReplicatorP2PClient.js');
const rpcClient=await readFile(rpcClientPath,'utf8');
const rpcTimeoutMarker='return { timeoutMs: timeout, signal };';
if(rpcClient.split(rpcTimeoutMarker).length!==2 || rpcClient.split('args, timeout);').length!==3)throw Error('Unexpected P2P RPC timeout boundary');
const rpcHelperImport=path.relative(path.dirname(rpcClientPath),path.join(source,'src/free-relay-settings.mjs')).split(path.sep).join('/');
await writeFile(rpcClientPath,`import {freeRelayRpcTimeout} from ${JSON.stringify(rpcHelperImport)};\n`+rpcClient.replace(rpcTimeoutMarker,'return { timeoutMs: freeRelayRpcTimeout(this._server?.settings, timeout), signal };').replaceAll('args, timeout);','args, this.getCallOptions(timeout));'));
// Free status must follow the authenticated socket, rather than a retained room.
const hostPath=path.join(path.dirname(roomOwnerPath),'TrysteroReplicatorP2PServer.js');
let hostSource=await readFile(hostPath,'utf8');
const hostImport='import { selfId, joinRoom } from "@trystero-p2p/nostr";',hostServing='return this._room !== void 0;',hostRoom='    await this.setRoom(room);';
for(const marker of [hostImport,hostServing,hostRoom])if(hostSource.split(marker).length!==2)throw Error('Unexpected Free signal readiness boundary');
const hostHelper=path.relative(path.dirname(hostPath),path.join(source,'src/free-relay-settings.mjs')).split(path.sep).join('/');
hostSource=`import {freeRelaySignalIsOpen,waitForFreeRelaySignal} from ${JSON.stringify(hostHelper)};\n`+hostSource.replace(hostImport,'import { selfId, joinRoom, getRelaySockets } from "@trystero-p2p/nostr";').replace(hostServing,'return this._room !== void 0 && freeRelaySignalIsOpen(this.settings, getRelaySockets());').replace(hostRoom,hostRoom+'\n    await waitForFreeRelaySignal(this.settings,getRelaySockets,()=>this._room===room);');
await writeFile(hostPath,hostSource);
const roomOwner=await readFile(roomOwnerPath,'utf8'),roomMarker='        ...binding.settings,\n        P2P_iceServers: iceServers,';
if(roomOwner.split(roomMarker).length!==2)throw Error('Unexpected P2P prepared-settings boundary');
const ownerHelper=path.relative(path.dirname(roomOwnerPath),path.join(source,'src/free-relay-settings.mjs')).split(path.sep).join('/');
const expiryMarker='    if (!settings) return false;';
if(roomOwner.split(expiryMarker).length!==2)throw Error('Unexpected Free expiry boundary');
await writeFile(roomOwnerPath,`import {freeRelayCredentialsUsable,isFreeRelayConnection} from ${JSON.stringify(ownerHelper)};\n`+roomOwner.replace(expiryMarker,expiryMarker+'\n    if (!freeRelayCredentialsUsable(settings)) return false;').replace('      await session.retire();','      await session.retire();\n      if (isFreeRelayConnection(session.host.settings)) this.automationCoordinator.beginLifecycle();').replace(roomMarker,'        ...binding.settings,\n        P2P_relays: prepared.P2P_relays,\n        P2P_iceServers: iceServers,').replace('if (hasManagedP2PTurnConfiguration(binding.settings)) {', 'if (hasManagedP2PTurnConfiguration(binding.settings) || binding.settings.P2P_relays === "wss://arcalink.ru/sync-lab/free/signal") {'));
const peerReplicatorPath=path.join(path.dirname(roomOwnerPath),'TrysteroReplicator.js');
const peerReplicator=await readFile(peerReplicatorPath,'utf8'),peerLeftMarker='  onPeerLeaved(peerId) {',retireMarker='      await session.retire();';
if(peerReplicator.split(peerLeftMarker).length!==2||roomOwner.split(retireMarker).length!==2)throw Error('Unexpected Free reconnect baseline boundary');
const peerHelper=path.relative(path.dirname(peerReplicatorPath),path.join(source,'src/free-relay-settings.mjs')).split(path.sep).join('/');
const acceptedMarker='    if (acceptance !== "accepted") return;';
if(peerReplicator.split(acceptedMarker).length!==2)throw Error('Unexpected Free automatic-watch boundary');
await writeFile(peerReplicatorPath,`import {isFreeRelayConnection} from ${JSON.stringify(peerHelper)};\n`+peerReplicator.replace(peerLeftMarker,peerLeftMarker+'\n    if (isFreeRelayConnection(this.server?.settings)) this.automationCoordinator.beginLifecycle();').replace(acceptedMarker,acceptedMarker+'\n    if (isFreeRelayConnection(this.server?.settings) && shouldAutoWatch) this.watchPeer(peer.peerId);'));
if(foldersLab){
  for(const file of [socketUtilsPath,nostrPath,nativePeerPath,strategyPath,roomOwnerPath]){
    let labSource=await readFile(file,'utf8');
    if(!labSource.includes('wss://arcalink.ru/sync-lab/free/signal'))throw Error('Missing folder lab relay boundary');
    labSource=labSource.replaceAll('wss://arcalink.ru/sync-lab/free/signal','wss://arcalink.ru/sync-lab/folders/free/signal');
    if(file===roomOwnerPath){
      const marker='        P2P_relays: prepared.P2P_relays,';
      if(labSource.split(marker).length!==2)throw Error('Unexpected folder lab room preparation');
      labSource=labSource.replace(marker,marker+'\n        P2P_roomID: prepared.P2P_roomID,');
    }
    await writeFile(file,labSource);
  }
}
const contentPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/common/utils.js');
const contentSource=await readFile(contentPath,'utf8'),contentMarker='function isTextDocument(doc) {';
if(contentSource.split(contentMarker).length!==2)throw Error('Unexpected upstream content decoding boundary');
await writeFile(contentPath,contentSource.replace(contentMarker,contentMarker+'\n  if (doc.type == "newnote" || doc.datatype == "newnote") return false;'));
for(const name of ['index.js','index.es.js']){
 const idbPath=path.join(source,'node_modules/pouchdb-adapter-idb/lib',name);
 await writeFile(idbPath,patchIdbMemory(await readFile(idbPath,'utf8')));
}
const largeReaderPath=path.join(source,'node_modules/@vrtmrz/livesync-commonlib/dist/managers/EntryManager/EntryManagerImpls.js');
await writeFile(largeReaderPath,patchLargeContent(await readFile(largeReaderPath,'utf8')));
const binaryDecoderPath=path.join(source,'node_modules/octagonal-wheels/dist/binary/index.js');
await writeFile(binaryDecoderPath,patchDecodedBinary(await readFile(binaryDecoderPath,'utf8')));
}
