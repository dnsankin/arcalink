import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {patchConfigDoctor} from '../scripts/patch-config-doctor.mjs';
const file=new URL('../.cache/source/src/serviceFeatures/startupLifecycle/configDoctor.ts',import.meta.url);
const source=fs.readFileSync(file,'utf8');
function fixture(rules){
 let consultations=0,saves=0,rebuilds=0;
 const context={checkUnsuitableValues:()=>({rules}),RuleLevel:{Recommended:2,Optional:3},RebuildOptions:{SkipEvenIfRequired:2,AutomaticAcceptable:0},performDoctorConsultation:async(_,settings)=>{consultations++;return {settings,isModified:false,shouldRebuild:false,shouldRebuildLocal:false};}};
 const code=patchConfigDoctor(source).replace(/^import[\s\S]*?;\n/gm,'').replace(/\bexport /g,'');
 runInNewContext(stripTypeScriptTypes(code,{mode:'transform'})+'\nglobalThis.run=runConfigDoctor;',context);
 const settings={customChunkSize:0},deps={settings,confirm:{},translate:k=>k,setSettings:()=>{throw Error('Unexpected settings mutation');},saveSettings:async()=>saves++,rebuilder:{scheduleFetch:async()=>rebuilds++,scheduleRebuild:async()=>rebuilds++},performRestart:()=>{throw Error('Unexpected restart');}};
 return {run:(...args)=>context.run(deps,...args),settings,stats:()=>({consultations,saves,rebuilds})};
}
test('automatic recommendations do not show a modal, modify chunk size or rebuild',async()=>{
 const f=fixture({customChunkSize:{level:2}});assert.equal(await f.run(),true);assert.equal(f.settings.customChunkSize,0);assert.deepEqual(f.stats(),{consultations:0,saves:0,rebuilds:0});
});
test('mandatory, necessary and unknown checks retain the original consultation',async()=>{
 for(const level of [0,1,undefined,99]){const f=fixture({required:{level},customChunkSize:{level:2}});await f.run();assert.equal(f.stats().consultations,1);}
});
test('manual and forced consultations remain available',async()=>{
 for(const args of [[false,'manual',false],[false,'updated',true]]){const f=fixture({customChunkSize:{level:2}});await f.run(...args);assert.equal(f.stats().consultations,1);}
});
test('transform is idempotent and refuses unexpected engine source',()=>{
 assert.equal(patchConfigDoctor(patchConfigDoctor(source)),patchConfigDoctor(source));assert.throws(()=>patchConfigDoctor('unexpected source'));
});
