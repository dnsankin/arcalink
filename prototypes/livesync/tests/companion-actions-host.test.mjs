import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from '../.cache/source/node_modules/esbuild/lib/main.js';
import {actionLinkRequestProof} from '../plugin/companion-action-link.mjs';
import {actionHash} from '../plugin/companion-action-outbox.mjs';

// Exercise the actual coordinator. Network/database construction is forbidden
// while the local handshake is tested; no transfer of sync authority is permitted.
const bundled=await build({entryPoints:[fileURLToPath(new URL('../plugin/companion-actions.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',
 nodePaths:[fileURLToPath(new URL('../.cache/source/node_modules',import.meta.url))],plugins:[{name:'local-host-only',setup(api){
  const stubs={obsidian:'export async function requestUrl(){throw Error("network forbidden");}', './companion-action-codec':'export class CompanionActionCodec{constructor(){throw Error("database forbidden");}}','./companion-peer-action-service':'export class CompanionPeerActionService{constructor(p,state){this.state=state} async start(){} dispose(){} async enroll(profile,bound){return {account:profile.accountId,workspace:profile.workspaceId,sourceVaultId:this.state().vaultId,sourceDeviceId:bound.session.deviceId,receiverId:"receiver_1234",ledgerEpoch:"epoch_1234",grantId:"grant_1234",secret:"ab".repeat(32)}}}'};
  api.onResolve({filter:/.*/},args=>Object.hasOwn(stubs,args.path)?{path:args.path,namespace:'fixture'}:undefined);
  api.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
 }}]});
const directory=await mkdtemp(join(tmpdir(),'arcalink-action-host-')),module=join(directory,'host.mjs');
await writeFile(module,bundled.outputFiles[0].text);const {CompanionActions}=await import(pathToFileURL(module).href);await rm(directory,{recursive:true,force:true});
const secret='synthetic local binding token only',root='.obsidian/plugins/arcalink-sync/companion';
const key=await crypto.subtle.generateKey({name:'RSA-OAEP',hash:'SHA-256',modulusLength:3072,publicExponent:new Uint8Array([1,0,1])},true,['encrypt','decrypt']);
const spki=new Uint8Array(await crypto.subtle.exportKey('spki',key.publicKey));
async function fixture(phase){
 const files=new Map(),dirs=new Set(),settings={isConfigured:true,encrypt:false,passphrase:'',idDerivationVersion:0},workspaceId='a'.repeat(32);
 const session={email:'fixture@example.invalid',deviceId:randomUUID(),refreshToken:secret};let state=null,cancellations=0,suspended=false;
 const owner={state:phase?{phase}:null,get blocksOrdinary(){return false;},async cancel(){cancellations++;this.state={phase:'cancelled'};suspended=false;return true;}};
 const adapter={stat:async path=>files.has(path)?{type:'file',size:Buffer.byteLength(files.get(path))}:null,exists:async path=>files.has(path)||dirs.has(path),
  read:async path=>files.get(path),write:async(path,text)=>files.set(path,text),mkdir:async path=>dirs.add(path),list:async()=>({files:[],folders:[]})};
 const plugin={app:{vault:{adapter},loadLocalStorage:()=>state,saveLocalStorage:(_,value)=>{state=structuredClone(value);}},pilotDirectory:root.slice(0,-10),
  unifiedVault:{saved:async()=>({workspaceId,auth:session})},workspaces:{session:async()=>({workspaceId})},freeRelay:{session:async()=>null},companionOwnership:owner,
  folderPolicies:{protectedPaths:[]},folders:{records:[]},desktop:{settings:{exchangeFolder:'Exchange'}},core:{services:{setting:{currentSettings:()=>settings},appLifecycle:{isSuspended:()=>suspended}}}};
 const host=new CompanionActions(plugin);await host.tick();
 const capability=()=>JSON.parse(files.get(root+'/actions-capabilities.json'));
 const request={schema:1,nonce:randomUUID(),generation:randomUUID(),accountId:randomUUID(),workspaceId,companionDeviceId:randomUUID(),pluginDeviceId:session.deviceId,localVaultId:capability().localVaultId,email:session.email,
  phase:'actions-prepare',independentActions:1,keyTransfer:{spki:Buffer.from(spki).toString('base64'),publicKeyFingerprint:await actionHash(spki),expiresAt:Date.now()+600000}};
 request.proof=await actionLinkRequestProof(request,secret);
 const publish=()=>files.set(root+'/actions-request.json',JSON.stringify(request));publish();
 return {host,plugin,request,publish,capability,settings,files,cancellations:()=>cancellations};
}
test('independent handshake never grants or cancels ordinary sync authority',async()=>{
 for(const phase of [null,'preparing','held','committing','committed']){const f=await fixture(phase);await f.host.tick();
  assert.equal(f.cancellations(),0);assert.equal(f.capability().legacyBlocked,false);assert.equal(f.capability().legacyCancellable,false);
  assert.ok(f.files.has(root+'/actions-response.json'));assert.equal(f.host.error,'');
 }
});
test('unverified local request cannot obtain independent settings',async()=>{
 const f=await fixture('preparing');f.request.proof='0'.repeat(64);f.publish();await f.host.tick();assert.equal(f.cancellations(),0);assert.equal(f.files.has(root+'/actions-response.json'),false);
});
test('configuration revision changes on meaningful settings changes while retries retain the same encrypted response',async()=>{
 const f=await fixture(null);await f.host.tick();const first=f.files.get(root+'/actions-response.json'),id=f.capability().configurationId;
 await f.host.tick();assert.equal(f.files.get(root+'/actions-response.json'),first);assert.equal(f.capability().configurationId,id);
 f.plugin.desktop.settings.exchangeFolder='Inbox';await f.host.tick();assert.notEqual(f.capability().configurationId,id);assert.equal(f.files.get(root+'/actions-response.json'),first);
 f.request.nonce=randomUUID();f.request.proof=await actionLinkRequestProof(f.request,secret);f.publish();await f.host.tick();assert.notEqual(f.files.get(root+'/actions-response.json'),first);
 assert.equal(f.cancellations(),0);
});
test('a linked profile never silently switches between cloud and peer transports',async()=>{
 for(const initial of ['cloud','p2p']){const f=await fixture(null),switchMode=mode=>{f.settings.remoteType=mode==='p2p'?'ONLY_P2P':'COUCHDB';f.settings.P2P_relays='wss://arcalink.ru/sync-lab/free/signal';};switchMode(initial);await f.host.tick();const response=f.files.get(root+'/actions-response.json');assert.ok(response);switchMode(initial==='cloud'?'p2p':'cloud');f.request.nonce=randomUUID();f.request.proof=await actionLinkRequestProof(f.request,secret);f.publish();await f.host.tick();assert.equal(f.host.error,'action-link-binding-changed');assert.equal(f.files.get(root+'/actions-response.json'),response);}
});
