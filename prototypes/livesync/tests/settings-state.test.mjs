import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsState,settingsStateLabel,capabilityHint} from '../plugin/settings-state.mjs';
import {FREE_SIGNAL_URL} from '../plugin/free-relay-settings.mjs';
import {createMessageTranslator} from '../plugin/message-language.mjs';
import messages from '../plugin/message-catalog.mjs';
const cloud={isConfigured:true,liveSync:true,remoteType:'',couchDB_USER:'test'};
const saved={settings:cloud,signedIn:true,telegram:true,shared:true,desktop:{tray:true}};
for(const [plan,paid] of [['begin',false],['personal_cloud',true]])test(plan+' reflects authoritative capabilities and configured sections',()=>{
 const r=settingsState({...saved,policy:{plan,sync_mode:'cloud',writable:true,paid}});
 assert.equal(r.sections.telegram,'configured');assert.equal(r.sections.sharing,'configured');
 for(const id of ['account','vaults','sync','desktop'])assert.equal(r.sections[id],'configured');
});
test('Free has gray cloud features even when all previous Pro settings are retained',()=>{
 const input={...saved,policy:{plan:'free',sync_mode:'relay',paid:false,writable:false}};
 const before=structuredClone(input),r=settingsState(input);
 assert.deepEqual(r.capabilities,{cloud:false,collaboration:false});assert.equal(r.sections.telegram,'unavailable');assert.equal(r.sections.sharing,'unavailable');
 assert.deepEqual(input,before,'Presentation must not erase config');
});
test('Free local transport overrides a stale paid snapshot during transition',()=>{
 const r=settingsState({...saved,settings:{...cloud,remoteType:'ONLY_P2P',P2P_relays:FREE_SIGNAL_URL+'?ticket=opaque',P2P_AutoSyncPeers:'~.*'},policy:{paid:true,writable:true,sync_mode:'cloud'}});
 assert.equal(r.sections.telegram,'unavailable');assert.equal(r.sections.sharing,'unavailable');assert.equal(r.sections.sync,'configured');
});
test('policy denies features despite stale active account response',()=>{
 const r=settingsState({...saved,policy:{paid:false,writable:false},account:{plan:'pro',billing_status:'active'}});
 assert.equal(r.sections.telegram,'unavailable');assert.equal(r.sections.sharing,'unavailable');
});
test('cloud credentials alone do not establish Pro or a downgrade',()=>{
 const r=settingsState({settings:cloud});assert.equal(r.capabilities.cloud,null);assert.equal(r.capabilities.collaboration,null);assert.equal(r.sections.sharing,'unconfigured');
});
test('fresh/default sections are neutral and generic info tabs never light up',()=>{
 const r=settingsState({desktop:{showHideHotkey:'Ctrl+Alt+O',quickNoteFolder:'Быстрые заметки'}});
 for(const id of ['account','vaults','sync','desktop','sharing','telegram'])assert.equal(r.sections[id],'unconfigured');
 assert.equal(r.sections.help,undefined);assert.equal(r.sections.changes,undefined);
});
for(const plan of ['personal_cloud','pro','solo','team'])test('legacy account plan alias '+plan+' recognizes active Pro',()=>{
 assert.equal(settingsState({account:{plan,billing_status:'active'}}).capabilities.collaboration,true);
});
test('expired subscription dims features; unknown plan never grants Pro',()=>{
 assert.equal(settingsState({...saved,account:{plan:'pro',billing_status:'canceled'}}).sections.sharing,'unavailable');
 assert.equal(settingsState({account:{plan:'unexpected',billing_status:'active'}}).capabilities.collaboration,null);
});
test('Begin/Pro updates can be projected without changing saved fields',()=>{
 const input={...saved,policy:{paid:false,writable:true}};
 assert.equal(settingsState(input).sections.sharing,'configured');input.policy.paid=true;
 assert.equal(settingsState(input).sections.sharing,'configured');assert.equal(input.telegram,true);
});
test('new hints and indicator labels translate completely',()=>{
 const translate=createMessageTranslator(messages);
 for(const text of [settingsStateLabel('configured'),settingsStateLabel('unavailable'),capabilityHint('cloud'),capabilityHint('collaboration')])assert.doesNotMatch(translate(text,'en'),/[А-Яа-яЁё]/);
});

test('publication lamp follows active pages independently of plan and selected section',()=>{
 assert.equal(settingsState({publications:true}).sections.publications,'configured');
 assert.equal(settingsState({publications:false}).sections.publications,'unconfigured');
 assert.equal(settingsState({publications:true,policy:{writable:false,paid:false,sync_mode:'relay'}}).sections.publications,'configured');
});

test('Begin shared folders are available without granting Pro capabilities',()=>{
 const result=settingsState({policy:{paid:false,writable:true,sync_mode:'cloud'},account:{plan:'begin',billing_status:'active'},shared:true});
 assert.equal(result.capabilities.collaboration,true);assert.equal(result.sections.sharing,'configured');
 assert.equal(settingsState({account:{plan:'begin',billing_status:'expired'}}).capabilities.collaboration,false);
});
