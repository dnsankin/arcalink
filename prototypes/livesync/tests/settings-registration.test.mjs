import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {patchSettingsRegistration} from '../scripts/patch-settings-registration.mjs';
const moduleSource=readFileSync(new URL('../.cache/source/src/modules/features/ModuleObsidianSettingTab.ts',import.meta.url),'utf8');
test('actual settings module registers its tab before a failing policy guard without bypassing that guard',async()=>{
 const hooks=[],events=[];
 const code=stripTypeScriptTypes(patchSettingsRegistration(moduleSource).replace(/^import .*;$/gm,'').replace('export class','class'),{mode:'transform'})+'\nglobalThis.Module=ModuleObsidianSettingDialogue;';
 const context={AbstractObsidianModule:class {},ObsidianLiveSyncSettingTab:class {reloadAllSettings(){events.push('settings-loaded');}},EVENT_REQUEST_OPEN_SETTINGS:'settings',eventHub:{onEvent(){}},openObsidianSettings(){}};
 runInNewContext(code,context);const module=new context.Module();module.app={};module.plugin={addSettingTab(){events.push('settings-tab');}};
 hooks.push({priority:-15,fn:async()=>{events.push('policy-refused');return false;}});
 hooks.push({priority:0,fn:async()=>{events.push('exchange');return true;}});
 module.onBindFunction({}, {appLifecycle:{onSettingLoaded:{addHandler(fn,priority=0){hooks.push({fn,priority});}}}});
 let ready=true;for(const h of hooks.sort((a,b)=>a.priority-b.priority)){if(!await h.fn()){ready=false;break;}}
 assert.equal(ready,false);assert.deepEqual(events,['settings-loaded','settings-tab','policy-refused']);
});
test('settings registration transform is idempotent and rejects unexpected upstream code',()=>{
 const patched=patchSettingsRegistration(moduleSource);assert.equal(patchSettingsRegistration(patched),patched);
 assert.throws(()=>patchSettingsRegistration('changed upstream lifecycle'),/Unexpected upstream/);
});
