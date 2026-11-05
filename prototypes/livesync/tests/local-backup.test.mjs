import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(source+'esbuild.config.mjs');
const output=await require('esbuild').build({stdin:{contents:`export {createLocalBackupStore,backupPath} from '../../plugin/local-backup-store.mjs';export {installLocalBackupHooks} from '../../plugin/local-backup-hooks.mjs';export {createBackupRestorer} from '../../plugin/local-backup-restore.mjs';`,resolveDir:source},bundle:true,platform:'node',format:'cjs',write:false,nodePaths:[source+'node_modules']});
const Module=require('node:module'),mod=new Module('local-backup-fixture');mod.filename=source+'local-backup-fixture.cjs';mod.paths=Module._nodeModulePaths(source);mod._compile(output.outputFiles[0].text,mod.filename);const {createLocalBackupStore,backupPath,installLocalBackupHooks,createBackupRestorer}=mod.exports;
const enc=s=>new TextEncoder().encode(s);const hex=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
function fixture(){let time=1000,failWrite=false,failRename=false;const files=new Map(),dirs=new Set(['.obsidian','.obsidian/plugins','.obsidian/plugins/arcalink-sync']);
 const stat=async p=>files.has(p)?{type:'file',size:files.get(p).bytes.length,mtime:files.get(p).time}:dirs.has(p)?{type:'folder',size:0,mtime:0}:null;
 const put=(p,b)=>{if(failWrite&&p.includes('/local-backups-v1/'))throw Error('disk full');files.set(p,{bytes:Uint8Array.from(b),time:++time});};
 const adapter={stat,exists:async p=>!!await stat(p),mkdir:async p=>{dirs.add(p);},read:async p=>new TextDecoder().decode(files.get(p).bytes),readBinary:async p=>files.get(p).bytes.slice().buffer,
  write:async(p,s)=>put(p,enc(s)),writeBinary:async(p,b)=>put(p,new Uint8Array(b)),appendBinary:async(p,b)=>{const a=files.get(p)?.bytes||new Uint8Array(),v=new Uint8Array(a.length+b.byteLength);v.set(a);v.set(new Uint8Array(b),a.length);put(p,v);},
  list:async p=>({files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...dirs].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}),
  remove:async p=>{files.delete(p);},rename:async(a,b)=>{if(failRename&&a.includes('/restore-')&&!a.endsWith('.old'))throw Error('rename failure');if(files.has(b))throw Error('destination exists');const v=files.get(a);if(!v)throw Error('missing');files.set(b,v);files.delete(a);},
  rmdir:async p=>{for(const x of files.keys())if(x.startsWith(p+'/'))files.delete(x);dirs.delete(p);},
 };
 const raw={...adapter},root='.obsidian/plugins/arcalink-sync/local-backups-v1';
 const readStream=async p=>(async function*(){const bytes=files.get(p).bytes;for(let i=0;i<bytes.length;i+=131071)yield bytes.slice(i,i+131071);})();
 const store=createLocalBackupStore({adapter:raw,root,readStream,now:()=>time});
 return {adapter,raw,root,readStream,store,files,dirs,put:(p,s)=>put(p,typeof s==='string'?enc(s):s),text:p=>new TextDecoder().decode(files.get(p).bytes),time:x=>{time=x;},diskFull:x=>{failWrite=x;},renameFailure:x=>{failRename=x;},reopen:()=>createLocalBackupStore({adapter:raw,root,readStream,now:()=>time})};
}
test('explicit opt-in, safe paths and service/root exclusion',async()=>{const f=fixture();f.put('note.md','old');assert.equal((await f.store.state()).settings.enabled,false);assert.equal(await f.store.capture('note.md'),null);for(const p of ['../file','/absolute','a//b','.obsidian/x','.trash/n','a/../b','a\\b'])assert.equal(backupPath(p),false,p);await f.store.configure({enabled:true});assert.ok(await f.store.capture('note.md'));assert.equal(await f.store.capture(f.root+'/index.a.json'),null);});
test('streamed chunks deduplicate exact versions and files; reopen and verify SHA',async()=>{const f=fixture();await f.store.configure({enabled:true});const data=new Uint8Array(1024*1024+7).fill(41);f.put('a.mp4',data);f.put('b.mp4',data);const a=await f.store.capture('a.mp4');assert.equal((await f.store.capture('a.mp4')).id,a.id);const b=await f.store.capture('b.mp4');assert.equal(a.sha256,b.sha256);assert.equal((await f.store.state()).versions.length,2);assert.equal((await f.store.state()).usedBytes,256*1024+7);assert.equal((await f.reopen().verify(a.id)).sha256,hex(data));});
test('corrupt object is never returned as a valid backup',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.md','before');const a=await f.store.capture('a.md');f.files.get(f.root+'/objects/'+a.chunks[0]).bytes[0]^=1;await assert.rejects(f.store.verify(a.id),/backup-object-corrupt/);});
test('valid alternate manifest survives a torn write; two corrupt slots fail closed',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.md','a');await f.store.capture('a.md');await f.store.cleanup();f.put(f.root+'/index.a.json','broken');assert.equal((await f.reopen().state()).versions.length,1);f.put(f.root+'/index.b.json','broken');await assert.rejects(f.reopen().state(),/unreadable/);});
test('expiry and GC preserve both recoverable manifests and remove unreferenced chunks',async()=>{const f=fixture();await f.store.configure({enabled:true,days:1});f.put('a.md','one');await f.store.capture('a.md');f.time(86400000*3);await f.store.cleanup();assert.equal((await f.store.state()).versions.length,0);assert.equal((await f.raw.list(f.root+'/objects')).files.length,0);f.put(f.root+'/index.a.json','torn');assert.equal((await f.reopen().state()).versions.length,0);});
test('quota rejects an oversized protected file before modifying it',async()=>{const f=fixture();await f.store.configure({enabled:true,maxBytes:1048576});f.put('big.bin',new Uint8Array(1048577));await assert.rejects(f.store.capture('big.bin'),/backup-file-exceeds-quota/);assert.equal(f.files.get('big.bin').bytes.length,1048577);});
test('pre-write and delete hooks preserve old bytes; disk errors block destructive operations',async()=>{const f=fixture();let enabled=true,errors=0;await f.store.configure({enabled:true});f.put('a.md','before');const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>enabled,capture:(...args)=>f.store.capture(...args),failed:()=>errors++});await f.adapter.write('a.md','after');assert.equal(f.text('a.md'),'after');let versions=(await f.store.state()).versions;assert.equal(versions.length,1);assert.equal(versions[0].sha256,hex(enc('before')));f.diskFull(true);await assert.rejects(f.adapter.remove('a.md'),/disk full/);assert.equal(f.text('a.md'),'after');assert.equal(errors,1);enabled=false;await f.adapter.remove('a.md');assert.equal(f.files.has('a.md'),false);dispose();assert.equal(f.adapter.write,f.raw.write);});
test('recursive folder deletion and rename protect all original files without backup recursion',async()=>{const f=fixture();f.dirs.add('Team');f.put('Team/a.md','a');f.put('Team/b.md','b');await f.store.configure({enabled:true});const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>true,capture:(...args)=>f.store.capture(...args),failed:e=>{throw e;}});await f.adapter.rename('Team/a.md','Team/c.md');await f.adapter.rmdir('Team',true);assert.deepEqual((await f.store.state()).versions.map(x=>x.path).sort(),['Team/a.md','Team/b.md','Team/c.md']);dispose();});
test('streamed restore verifies final bytes and removes journals; a failed publish restores old content',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.bin','before');const v=await f.store.capture('a.bin');f.put('a.bin','current');const r=createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream});f.renameFailure(true);await assert.rejects(r.restore(v,f.store.stream(v)),/rename failure/);assert.equal(f.text('a.bin'),'current');assert.equal(await f.raw.exists(f.root+'/restore.json'),false);f.renameFailure(false);await r.restore(v,f.store.stream(v));assert.equal(f.text('a.bin'),'before');assert.equal(await f.raw.exists(f.root+'/restore.json'),false);});
test('corrupt restore input cannot replace current content',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.bin','before');const v=await f.store.capture('a.bin');f.put('a.bin','current');const r=createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream});await assert.rejects(r.restore(v,(async function*(){yield enc('bad');})()),/staging-corrupt/);assert.equal(f.text('a.bin'),'current');});
test('unload cancels a pending capture before publishing a new manifest',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.md','one');f.store.dispose();await assert.rejects(f.store.capture('a.md'),/closed/);assert.equal((await f.reopen().state()).versions.length,0);});
test('quota evicts only older entries after a complete new protected backup',async()=>{const f=fixture();await f.store.configure({enabled:true,maxBytes:1048576});const a=new Uint8Array(700000);for(let i=0;i<a.length;i++)a[i]=i%251;f.put('a.bin',a);await f.store.capture('a.bin');const b=new Uint8Array(700000);for(let i=0;i<b.length;i++)b[i]=i%247;f.put('b.bin',b);const newest=await f.store.capture('b.bin');const state=await f.store.state();assert.ok(state.usedBytes<=1048576);assert.ok(state.versions.some(x=>x.id===newest.id));assert.equal((await f.store.verify(newest.id)).sha256,hex(b));});
test('changing the source during streaming cannot publish a false snapshot',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.md','one');const store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async p=>(async function*(){yield enc('one');f.put(p,'changed');})()});await assert.rejects(store.capture('a.md'),/source-changed/);assert.equal((await f.store.state()).versions.length,0);});
test('crash journal rolls back an interrupted move of the current file on next load',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.bin','old');const id=crypto.randomUUID(),stage=f.root+'/restore-'+id,previous=stage+'.old';f.put(previous,'old');f.put(stage,'new');f.files.delete('a.bin');f.put(f.root+'/restore.json',JSON.stringify({protocol:1,id,path:'a.bin',stage,previous,expected:hex(enc('old')),sha256:hex(enc('new'))}));await createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream}).recover();assert.equal(f.text('a.bin'),'old');assert.equal(await f.raw.exists(stage),false);});
test('committed target survives recovery; unrelated modifications prevent silent rollback',async()=>{const f=fixture();await f.store.configure({enabled:true});const id=crypto.randomUUID(),stage=f.root+'/restore-'+id,previous=stage+'.old',journal={protocol:1,id,path:'a.bin',stage,previous,expected:hex(enc('old')),sha256:hex(enc('new'))};f.put(previous,'old');f.put('a.bin','unexpected');f.put(f.root+'/restore.json',JSON.stringify(journal));const r=createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream});await assert.rejects(r.recover(),/recovery-conflict/);assert.equal(f.text('a.bin'),'unexpected');f.put('a.bin','new');await r.recover();assert.equal(f.text('a.bin'),'new');assert.equal(await f.raw.exists(previous),false);});
test('restore journal paths cannot escape the backup store or target hidden configuration',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put(f.root+'/restore.json',JSON.stringify({protocol:1,id:'safe-id',path:'.obsidian/config.json',stage:'/outside',previous:'/outside.old',expected:null,sha256:'a'.repeat(64)}));await assert.rejects(createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream}).recover(),/journal-invalid/);});
test('expected hash rejects concurrent target changes before staging a restore',async()=>{const f=fixture();await f.store.configure({enabled:true});f.put('a.bin','old');const v=await f.store.capture('a.bin');f.put('a.bin','other');await assert.rejects(createBackupRestorer({adapter:f.raw,root:f.root,readStream:f.readStream}).restore(v,f.store.stream(v),{expectedHash:hex(enc('old'))}),/target-changed/);assert.equal(f.text('a.bin'),'other');});

test('backup storage stays below the already excluded synchronizer directory',async()=>{
 const {pluginSyncSettings}=await import('../plugin/plugin-sync.mjs');
 for(const config of ['.obsidian','Settings Custom']){
  const settings=pluginSyncSettings(true,config,'arcalink-sync');
  const root=config+'/plugins/arcalink-sync/local-backups-v1';
  assert.equal(new RegExp(settings.syncInternalFilesIgnorePatterns).test(root+'/objects/'+ 'a'.repeat(64)),true);
 }
});

test('a custom visible configuration directory cannot recursively back up its own store',async()=>{
 const f=fixture(),root='Custom settings/plugins/arcalink-sync/local-backups-v1';
 const store=createLocalBackupStore({adapter:f.raw,root,readStream:f.readStream,accept:path=>!path.startsWith('Custom settings/')});
 await store.configure({enabled:true});f.put('Custom settings/plugins/arcalink-sync/private.json','secret');
 assert.equal(await store.capture('Custom settings/plugins/arcalink-sync/private.json'),null);
 assert.equal(await store.capture(root+'/index.a.json'),null);assert.equal((await store.state()).versions.length,0);
});

test('unchanged live files refresh retention without creating duplicate versions',async()=>{
 const f=fixture();await f.store.configure({enabled:true,days:1});f.put('a.md','same');const v=await f.store.capture('a.md');
 f.time(2*86400000);assert.equal((await f.store.capture('a.md')).id,v.id);await f.store.cleanup();
 assert.equal((await f.store.state()).versions.length,1);assert.equal((await f.store.verify(v.id)).sha256,hex(enc('same')));
});

test('disabling runs after the active capture and before a queued capture backlog',async()=>{const f=fixture();f.put('active.md','active bytes');f.put('queued.md','queued bytes');let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async path=>(async function*(){if(path==='active.md'){entered();await gate;}for await(const bytes of await f.readStream(path))yield bytes;})()});await store.configure({enabled:true});const first=store.capture('active.md');await started;const second=store.capture('queued.md'),disabled=store.configure({enabled:false}),idle=store.idle();release();assert.ok(await first);assert.equal((await disabled).enabled,false);assert.equal(await second,null,'queued captures must see persisted disabled state');await idle;assert.deepEqual((await store.state()).versions.map(v=>v.path),['active.md']);});
test('UI history reads can bypass the backlog but never observe a partial capture',async()=>{const f=fixture();f.put('active.md','one');f.put('queued.md','two');let entered,releaseFirst,releaseSecond,secondStarted=false;const started=new Promise(r=>entered=r),firstGate=new Promise(r=>releaseFirst=r),secondGate=new Promise(r=>releaseSecond=r),store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async path=>(async function*(){if(path==='active.md'){entered();await firstGate;}else{secondStarted=true;await secondGate;}for await(const bytes of await f.readStream(path))yield bytes;})()});await store.configure({enabled:true});const first=store.capture('active.md');await started;const second=store.capture('queued.md'),view=store.state({priority:true});releaseFirst();try{const state=await view;assert.deepEqual(state.versions.map(v=>v.path),['active.md']);assert.equal(state.versions[0].sha256,hex(enc('one')));}finally{releaseSecond();await Promise.all([first,second]);}assert.equal(secondStarted,true);assert.equal((await store.state()).versions.length,2);});
test('a rejected settings job does not strand queued captures or idle waiters',async()=>{const f=fixture();f.put('a.md','a');await f.store.configure({enabled:true});const bad=f.store.configure({days:0}),captured=f.store.capture('a.md'),idle=f.store.idle();await assert.rejects(bad,/invalid/);assert.ok(await captured);await idle;assert.equal((await f.store.state()).versions.length,1);});
test('opening a comparison verifies the saved bytes ahead of a capture backlog',async()=>{const f=fixture();f.put('saved.md','saved version');f.put('active.md','active');f.put('queued.md','queued');let entered,releaseFirst,releaseSecond;const started=new Promise(r=>entered=r),firstGate=new Promise(r=>releaseFirst=r),secondGate=new Promise(r=>releaseSecond=r),store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async path=>(async function*(){if(path==='active.md'){entered();await firstGate;}if(path==='queued.md')await secondGate;for await(const bytes of await f.readStream(path))yield bytes;})()});await store.configure({enabled:true});const saved=await store.capture('saved.md'),active=store.capture('active.md');await started;const queued=store.capture('queued.md'),verified=store.verify(saved.id,{priority:true});releaseFirst();try{assert.equal((await verified).sha256,hex(enc('saved version')));}finally{releaseSecond();await Promise.all([active,queued]);}});

const physicalBytes=f=>[...f.files].filter(([p])=>p.startsWith(f.root+'/objects/')).reduce((sum,[,v])=>sum+v.bytes.length,0);
const distinctFile=seed=>{const b=new Uint8Array(700000);for(let i=0;i<b.length;i++)b[i]=(i+seed)%251^seed;return b;};
test('repeated quota eviction reclaims physical blocks immediately and both slots remain recoverable',async()=>{
 const f=fixture();await f.store.configure({enabled:true,maxBytes:1048576});let latest;
 for(let i=1;i<=10;i++){f.put('a.bin',distinctFile(i));latest=await f.store.capture('a.bin');const state=await f.store.state();assert.equal(state.usedBytes,physicalBytes(f));assert.ok(physicalBytes(f)<=1048576);}
 assert.equal((await f.store.state()).versions.length,1);
 for(const slot of ['a','b']){const path=f.root+'/index.'+slot+'.json',saved=f.files.get(path);f.put(path,'torn');assert.equal((await f.reopen().verify(latest.id)).sha256,latest.sha256);f.files.set(path,saved);}
});
test('actual usage includes orphan blocks, then the next capture removes them',async()=>{
 const f=fixture();await f.store.configure({enabled:true});f.put('a.md','kept');const v=await f.store.capture('a.md');const orphan=enc('orphan');f.put(f.root+'/objects/'+hex(orphan),orphan);
 assert.equal((await f.store.state()).usedBytes,4+orphan.length);assert.equal((await f.store.capture('a.md')).id,v.id);assert.equal(physicalBytes(f),4);
});
test('a failed source capture leaves no accumulated unreferenced blocks',async()=>{
 const f=fixture();await f.store.configure({enabled:true});f.put('kept.md','kept');const kept=await f.store.capture('kept.md');
 const store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async p=>(async function*(){yield enc('new');f.put(p,'changed');})()});
 for(let i=0;i<3;i++){f.put('a.md','new');await assert.rejects(store.capture('a.md'),/source-changed/);assert.equal(physicalBytes(f),4);}
 assert.equal((await f.reopen().verify(kept.id)).sha256,kept.sha256);
});
test('failure to publish the second GC slot preserves blocks referenced by either recoverable slot',async()=>{
 const f=fixture();await f.store.configure({enabled:true,maxBytes:1048576});f.put('a.bin',distinctFile(1));const old=await f.store.capture('a.bin');f.put('a.bin',distinctFile(2));
 const write=f.raw.write;let writes=0;f.raw.write=async(p,s)=>{if(p.includes('/index.')&&++writes>=4)throw Error('manifest unavailable');return write(p,s);};
 await assert.rejects(f.store.capture('a.bin'),/manifest unavailable/);assert.equal((await f.store.state()).usedBytes,physicalBytes(f));assert.ok(physicalBytes(f)>1048576,'failed GC is reported as physical use');
 // Each valid slot still points to a complete readable version, even after the other slot is lost.
 for(const slot of ['a','b']){const path=f.root+'/index.'+slot+'.json',saved=f.files.get(path);f.put(path,'torn');const reopened=f.reopen();for(const v of (await reopened.state()).versions)await reopened.verify(v.id);f.files.set(path,saved);}
 assert.ok(old.chunks.every(h=>f.files.has(f.root+'/objects/'+h)));
 f.raw.write=write;await f.store.cleanup();assert.ok(physicalBytes(f)<=1048576);
});
test('active readers survive expiry and quota pruning until every reader releases',async()=>{
 const f=fixture();await f.store.configure({enabled:true,maxBytes:1048576,days:1});f.put('a.bin',distinctFile(1));const v=await f.store.capture('a.bin'),one=await f.store.retain(v.id),two=await f.store.retain(v.id);f.time(3*86400000);
 f.put('b.bin',distinctFile(2));await assert.rejects(f.store.capture('b.bin'),/quota-too-small/);assert.equal(physicalBytes(f),700000);await f.store.cleanup();await f.store.verify(v.id);
 let size=0;for await(const chunk of f.store.stream(one.version))size+=chunk.length;assert.equal(size,v.size);
 await one.release();await one.release();await f.store.cleanup();await f.store.verify(v.id);await two.release();await f.store.cleanup();assert.equal(physicalBytes(f),0);
});

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(setImmediate);
const hooks=f=>installLocalBackupHooks({adapter:f.adapter,enabled:()=>true,capture:(...args)=>f.store.capture(...args),failed:()=>{}});
test('two writes preserve the intermediate bytes while capture and mutation hold one path lock',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.put('a.md','initial');const write=f.adapter.write;
 f.adapter.write=async function(path,text){assert.equal(this,f.adapter);if(text==='first'){entered.resolve();await release.promise;}return write.call(this,path,text);};const dispose=hooks(f);
 const first=f.adapter.write('a.md','first');await entered.promise;let secondDone=false;const second=f.adapter.write('a.md','second').then(()=>secondDone=true);
 try{await turn();assert.equal(secondDone,false);assert.equal(f.text('a.md'),'initial');}finally{release.resolve();await Promise.all([first,second]);dispose();}
 assert.equal(f.text('a.md'),'second');assert.deepEqual((await f.store.state()).versions.map(v=>v.sha256),[hex(enc('initial')),hex(enc('first'))]);
});
test('unrelated paths proceed while another original write is paused',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.put('a.md','A');f.put('b.md','B');const write=f.adapter.write;
 f.adapter.write=async function(path,text){if(path==='a.md'){entered.resolve();await release.promise;}return write.call(this,path,text);};const dispose=hooks(f),first=f.adapter.write('a.md','A2');await entered.promise;
 try{await f.adapter.write('b.md','B2');assert.equal(f.text('b.md'),'B2');assert.equal(f.text('a.md'),'A');}finally{release.resolve();await first;dispose();}
});
test('rename reserves both source and destination through the actual move',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.put('a.md','A');f.put('b.md','B');
 f.adapter.rename=async function(a,b){assert.equal(this,f.adapter);entered.resolve();await release.promise;await f.raw.remove(b);await f.raw.rename(a,b);return 'moved';};const dispose=hooks(f),renamed=f.adapter.rename('a.md','b.md');await entered.promise;
 let sourceDone=false,targetDone=false;const source=f.adapter.write('a.md','new source').then(()=>sourceDone=true),target=f.adapter.write('b.md','new target').then(()=>targetDone=true);
 try{await turn();assert.equal(sourceDone,false);assert.equal(targetDone,false);}finally{release.resolve();assert.equal(await renamed,'moved');await Promise.all([source,target]);dispose();}
 assert.equal(f.text('a.md'),'new source');assert.equal(f.text('b.md'),'new target');assert.deepEqual((await f.store.state()).versions.filter(v=>v.path==='b.md').map(v=>v.sha256),[hex(enc('B')),hex(enc('A'))]);
});
test('recursive folder removal waits for a descendant write and captures its completed bytes',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.dirs.add('Team');f.put('Team/a.md','before');const write=f.adapter.write;
 f.adapter.write=async function(...args){entered.resolve();await release.promise;return write.apply(this,args);};const dispose=hooks(f),first=f.adapter.write('Team/a.md','intermediate');await entered.promise;
 let removed=false;const removal=f.adapter.rmdir('Team',true).then(()=>removed=true);
 try{await turn();assert.equal(removed,false);}finally{release.resolve();await Promise.all([first,removal]);dispose();}
 assert.equal(f.files.has('Team/a.md'),false);assert.deepEqual((await f.store.state()).versions.map(v=>v.sha256),[hex(enc('before')),hex(enc('intermediate'))]);
});
test('directory rename locks destination descendants until publication completes',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.dirs.add('Team');f.put('Team/a.md','before');
 f.adapter.rename=async(a,b)=>{entered.resolve();await release.promise;f.dirs.add(b);await f.raw.rename(a+'/a.md',b+'/a.md');f.dirs.delete(a);};const dispose=hooks(f),renamed=f.adapter.rename('Team','Moved');await entered.promise;
 let written=false;const write=f.adapter.write('Moved/a.md','after').then(()=>written=true);
 try{await turn();assert.equal(written,false);}finally{release.resolve();await Promise.all([renamed,write]);dispose();}
 assert.equal(f.text('Moved/a.md'),'after');assert.ok((await f.store.state()).versions.some(v=>v.path==='Moved/a.md'&&v.sha256===hex(enc('before'))));
});
test('binary append and removal share the same lock as text writes',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();await f.store.configure({enabled:true});f.put('a.md','A');const write=f.adapter.write;
 f.adapter.write=async function(...args){entered.resolve();await release.promise;return write.apply(this,args);};const dispose=hooks(f),first=f.adapter.write('a.md','B');await entered.promise;
 const appended=f.adapter.appendBinary('a.md',enc('C').buffer),removed=f.adapter.remove('a.md');
 try{await turn();assert.equal(f.text('a.md'),'A');}finally{release.resolve();await Promise.all([first,appended,removed]);dispose();}
 assert.equal(f.files.has('a.md'),false);assert.deepEqual((await f.store.state()).versions.map(v=>v.sha256),['A','B','BC'].map(s=>hex(enc(s))));
});
test('backup and original-operation failures release locks without rejecting queued successors',{timeout:3000},async()=>{
 for(const where of ['backup','write']){
  const f=fixture(),entered=gate(),release=gate();f.put('a.md','before');let first=true,errors=0;const write=f.adapter.write;
  if(where==='write')f.adapter.write=async function(...args){if(first){first=false;entered.resolve();await release.promise;throw Error('write failure');}return write.apply(this,args);};
  const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>true,failed:()=>errors++,capture:async()=>{if(where==='backup'&&first){first=false;entered.resolve();await release.promise;throw Error('backup failure');}}});
  const failed=assert.rejects(f.adapter.write('a.md','bad'),new RegExp(where+' failure'));await entered.promise;const next=f.adapter.write('a.md','good');release.resolve();await Promise.all([failed,next]);dispose();assert.equal(f.text('a.md'),'good');assert.equal(errors,where==='backup'?1:0);
 }
});
test('disabling during an in-flight write cannot let a later mutation overtake it',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();f.put('a.md','before');let enabled=true,captures=0;const write=f.adapter.write;
 f.adapter.write=async function(path,text){if(text==='first'){entered.resolve();await release.promise;}return write.call(this,path,text);};
 const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>enabled,capture:async()=>captures++,failed:()=>{}}),first=f.adapter.write('a.md','first');await entered.promise;enabled=false;
 let secondDone=false;const second=f.adapter.write('a.md','second').then(()=>secondDone=true);try{await turn();assert.equal(secondDone,false);}finally{release.resolve();await Promise.all([first,second]);dispose();}
 assert.equal(f.text('a.md'),'second');assert.equal(captures,1);
});
test('internal backup writes can re-enter the adapter without waiting on the outer protected write',{timeout:3000},async()=>{
 const f=fixture();f.put('a.md','old');let captures=0;
 const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>true,failed:()=>{},capture:async()=>{captures++;await f.adapter.write(f.root+'/test-index','saved');}});
 await f.adapter.write('a.md','new');dispose();assert.equal(captures,1);assert.equal(f.text(f.root+'/test-index'),'saved');assert.equal(f.text('a.md'),'new');
});
test('case and Unicode-equivalent paths are serialized conservatively',{timeout:3000},async()=>{
 const f=fixture(),entered=gate(),release=gate();let calls=0;const write=f.adapter.write;
 f.adapter.write=async function(...args){if(++calls===1){entered.resolve();await release.promise;}return write.apply(this,args);};const dispose=hooks(f),first=f.adapter.write('Caf\u00e9.md','one');await entered.promise;
 const second=f.adapter.write('CAFE\u0301.md','two');try{await turn();assert.equal(calls,1);}finally{release.resolve();await Promise.all([first,second]);dispose();}assert.equal(calls,2);
});
test('trash results, original arguments and receiver survive interception',{timeout:3000},async()=>{
 const f=fixture();f.put('a.md','before');const calls=[];f.adapter.trashSystem=async function(...args){calls.push([this,...args]);return false;};f.adapter.trashLocal=async function(path){calls.push([this,path]);await f.raw.remove(path);};const dispose=hooks(f);
 assert.equal(await f.adapter.trashSystem('a.md'),false);await f.adapter.trashLocal('a.md');dispose();assert.deepEqual(calls,[[f.adapter,'a.md'],[f.adapter,'a.md']]);assert.equal(f.files.has('a.md'),false);
});

test('pre-write capture passes a background backlog only after the active backup commits',async()=>{
 const f=fixture(),events=[];for(const [path,bytes] of [['active.md','active'],['queued.md','queued'],['note.md','before']])f.put(path,bytes);
 let entered,releaseActive,releaseQueued;const started=new Promise(r=>entered=r),activeGate=new Promise(r=>releaseActive=r),queuedGate=new Promise(r=>releaseQueued=r);
 const store=createLocalBackupStore({adapter:f.raw,root:f.root,readStream:async path=>(async function*(){events.push(path);if(path==='active.md'){entered();await activeGate;}if(path==='queued.md')await queuedGate;for await(const bytes of await f.readStream(path))yield bytes;})()});
 await store.configure({enabled:true});const active=store.capture('active.md');await started;const queued=store.capture('queued.md');
 const dispose=installLocalBackupHooks({adapter:f.adapter,enabled:()=>true,capture:(path,reason)=>store.capture(path,reason,{priority:true}),failed:e=>{throw e;}});
 let replaced=false;const write=f.adapter.write('note.md','after').then(()=>replaced=true);await new Promise(r=>setImmediate(r));assert.equal(replaced,false);
 releaseActive();try{await write;assert.equal(f.text('note.md'),'after');assert.deepEqual(events.slice(0,2),['active.md','note.md']);}
 finally{releaseQueued();await Promise.all([active,queued]);dispose();}
 const saved=(await store.state()).versions.find(v=>v.path==='note.md');assert.equal(saved.sha256,hex(enc('before')));
});
