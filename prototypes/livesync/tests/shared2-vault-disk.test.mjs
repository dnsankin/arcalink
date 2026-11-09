import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const sourceDir=fileURLToPath(new URL('../.cache/source/',import.meta.url)),require=createRequire(sourceDir+'esbuild.config.mjs');const {build}=require('esbuild');
const output=(await build({stdin:{contents:"export {createShared2VaultDisk} from '../../plugin/shared2-vault-disk.mjs';export {createShared2LiveSyncStorage} from '../../plugin/shared2-livesync-storage.mjs';export {hashShared2Stream} from '../../plugin/shared2-stream-hash.mjs';",resolveDir:sourceDir},bundle:true,write:false,platform:'node',format:'cjs',nodePaths:[sourceDir+'node_modules']})).outputFiles[0].text;const Module=require('node:module'),mod=new Module('shared2-disk-test');mod.filename=sourceDir+'shared2-disk-test.cjs';mod.paths=Module._nodeModulePaths(sourceDir);mod._compile(output,mod.filename);const {createShared2VaultDisk,createShared2LiveSyncStorage,hashShared2Stream}=mod.exports;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'arcalink-shared2-disk-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let crash=false,moved=false;
 const full=name=>path.join(root,name);
 const adapter={exists:async name=>{try{await fs.stat(full(name));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}},mkdir:async name=>fs.mkdir(full(name)),writeBinary:async(name,data)=>fs.writeFile(full(name),new Uint8Array(data)),appendBinary:async(name,data)=>{assert.ok(data.byteLength<=256*1024);return fs.appendFile(full(name),new Uint8Array(data));},copy:async(from,to)=>fs.copyFile(full(from),full(to)),remove:async name=>fs.unlink(full(name)),rename:async(from,to)=>{if(crash&&moved)throw Error('synthetic crash');if(await adapter.exists(to))throw Error('Destination already exists');await fs.rename(full(from),full(to));if(to.endsWith('.old'))moved=true;},list:async name=>{const entries=await fs.readdir(full(name),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>name+'/'+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>name+'/'+e.name)};},readBinary:async name=>(await fs.readFile(full(name))).buffer.slice(0),stat:async name=>{const s=await fs.stat(full(name));return {size:s.size};}};
 // Buffer's backing ArrayBuffer can be pooled; return only the exact range.
 adapter.readBinary=async name=>{const value=await fs.readFile(full(name));return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);};
 const readStream=async name=>(async function*(){const file=await fs.open(full(name),'r');try{for await(const chunk of file.readableWebStream({type:'bytes'}))yield new Uint8Array(chunk);}finally{await file.close();}})();
 const options={adapter,mount:'Team',privateRoot:'ArcaLink Shared/shared2-test',listFiles:async()=>[],readStream,readBlob:async name=>new Blob([await fs.readFile(full(name))]),beforeCommit:async(relative,fn)=>fn()};
 await fs.mkdir(full('Team'));return {root,adapter,options,disk:createShared2VaultDisk(options),crash:value=>{crash=value;moved=false;},read:async name=>fs.readFile(full(name)),write:async(name,data)=>fs.writeFile(full(name),data)};
}
const stream=value=>(async function*(){yield new Uint8Array(value);})();
test('bounded physical replacement works when rename cannot overwrite and removes transient duplicates',async t=>{const f=await fixture(t),old=Buffer.from('old'),next=Buffer.alloc(1024*1024+19,121);await f.write('Team/a.bin',old);await f.disk.replace('a.bin',stream(next),{expectedHash:hash(old),sha256:hash(next),size:next.length});assert.deepEqual(await f.read('Team/a.bin'),next);assert.equal((await f.adapter.list('ArcaLink Shared/shared2-test/staging')).files.length,0);assert.equal((await f.adapter.list('ArcaLink Shared/shared2-test/commits')).files.length,0);});
test('restart restores displaced original after interruption before new file rename',async t=>{const f=await fixture(t),old=Buffer.from('original'),next=Buffer.from('new');await f.write('Team/a.bin',old);f.crash(true);await assert.rejects(f.disk.replace('a.bin',stream(next),{expectedHash:hash(old),sha256:hash(next),size:next.length}),/synthetic crash/);assert.equal(await f.adapter.exists('Team/a.bin'),false);f.crash(false);await createShared2VaultDisk(f.options).recover();assert.deepEqual(await f.read('Team/a.bin'),old);assert.equal((await f.adapter.list('ArcaLink Shared/shared2-test/commits')).files.length,0);});
test('stale local fingerprint and corrupt incoming stream cannot replace local content',async t=>{const f=await fixture(t),old=Buffer.from('untouched'),next=Buffer.from('new');await f.write('Team/a.bin',old);await assert.rejects(f.disk.replace('a.bin',stream(next),{expectedHash:hash(Buffer.from('stale')),sha256:hash(next),size:next.length}),/local-file-changed/);await assert.rejects(f.disk.replace('a.bin',stream(old),{expectedHash:hash(old),sha256:hash(next),size:next.length}),/proof-mismatch/);assert.deepEqual(await f.read('Team/a.bin'),old);});
test('content-addressed recovery copies are reused and corrupt copies never authorize deletion',async t=>{const f=await fixture(t),data=Buffer.from('local version');await f.write('Team/a.bin',data);const first=await f.disk.backup('a.bin',hash(data)),second=await f.disk.backup('a.bin',hash(data));assert.equal(first,second);assert.equal((await f.adapter.list('ArcaLink Shared/shared2-test/backups')).files.length,1);await f.write(first,Buffer.from('corrupted'));await assert.rejects(f.disk.remove('a.bin',{expectedHash:hash(data)}),/backup-proof-mismatch/);assert.deepEqual(await f.read('Team/a.bin'),data);});

async function liveStorage(t){
 const f=await fixture(t),preserved=[];let permit=true,save=true;
 const stat=async name=>{if(!await f.adapter.exists(name))return null;const value=await fs.stat(path.join(f.root,name));return {type:value.isDirectory()?'folder':'file',size:value.size,ctime:value.ctimeMs,mtime:value.mtimeMs};};
 const storage={getStub:async name=>{const current=await stat(name);if(!current)return null;const listing=await f.adapter.list(name.slice(0,name.lastIndexOf('/'))),names=[...listing.files,...listing.folders];const canonical=names.includes(name)?name:names.find(value=>value.toLowerCase()===name.toLowerCase());return canonical?{path:canonical,name:canonical.split('/').at(-1),stat:current}:null;},getFiles:async()=>[],normalisePath:name=>name,touched:async()=>{},triggerFileEvent:()=>{},renameFile:async(file,destination)=>{await fs.rename(path.join(f.root,file.path),path.join(f.root,destination));return storage.getStub(destination);}};
 const live=createShared2LiveSyncStorage({storage,disk:f.disk,mount:'Team',stat,hashStream:hashShared2Stream,
  commit:async(_path,operation)=>{if(!permit)throw Error('lease-rejected');return operation();},
  preserve:async record=>{if(!save)throw Error('recovery-index-failed');preserved.push(record);}});
 return {...f,storage,live,preserved,permit:value=>permit=value,save:value=>save=value};
}
test('ordinary LiveSync storage retains shared preimages and commits a multi-block native file',async t=>{
 const f=await liveStorage(t),original=Buffer.from('Previous native version'),next=Buffer.alloc(1024*1024+17,87);
 await f.write('Team/a.bin',original);const stub=await f.live.getFileStub('Team/a.bin');
 assert.deepEqual(Buffer.from(await (await f.live.readStubContent(stub)).body.arrayBuffer()),original);
 assert.equal(await f.live.writeFileAuto('Team/a.bin',next),true);
 assert.deepEqual(await f.read('Team/a.bin'),next);
 assert.deepEqual(await f.read(f.preserved[0].backup),original);
 await f.live.getStub('Team/a.bin');await f.live.deleteVaultItem('Team/a.bin');
 assert.equal(await f.adapter.exists('Team/a.bin'),false);
 assert.deepEqual(await f.read(f.preserved.at(-1).backup),next);
});
test('identical incoming bytes keep the native file and reject stale observations',async t=>{
 const f=await liveStorage(t),original=Buffer.from('Previous native version'),name='Team/a.bin';
 await f.write(name,original);
 await f.live.getStub(name);
 const before=await fs.stat(path.join(f.root,name));
 f.save(false);
 f.permit(false);
 await assert.rejects(f.live.writeFileAuto(name,original),/lease-rejected/);
 f.permit(true);
 assert.equal(await f.live.writeFileAuto(name,original),true);
 const after=await fs.stat(path.join(f.root,name));
 assert.equal(after.ino,before.ino);
 assert.equal(after.mtimeMs,before.mtimeMs);
 assert.deepEqual(f.preserved,[]);
 assert.equal(await f.adapter.exists('ArcaLink Shared/shared2-test/staging'),false);
 await f.write(name,Buffer.from('Concurrent local edit'));
 await assert.rejects(f.live.writeFileAuto(name,original),/local-file-changed/);
 assert.equal((await f.read(name)).toString(),'Concurrent local edit');
});
test('changed bytes, revoked lease and failed recovery index cannot replace native content',async t=>{
 const f=await liveStorage(t);await f.write('Team/a.bin',Buffer.from('Original'));
 await f.live.getStub('Team/a.bin');await f.write('Team/a.bin',Buffer.from('Offline edit'));
 await assert.rejects(f.live.writeFileAuto('Team/a.bin',Buffer.from('Incoming')),/local-file-changed/);
 assert.equal((await f.read('Team/a.bin')).toString(),'Offline edit');
 await f.live.getStub('Team/a.bin');f.permit(false);
 await assert.rejects(f.live.deleteVaultItem('Team/a.bin'),/lease-rejected/);
 f.permit(true);f.save(false);
 await assert.rejects(f.live.writeFileAuto('Team/a.bin',Buffer.from('Incoming')),/recovery-index-failed/);
 assert.equal((await f.read('Team/a.bin')).toString(),'Offline edit');
});
test('new native paths require an absence observation and existing personal paths cannot be routed',async t=>{
 const f=await liveStorage(t);
 await assert.rejects(f.live.writeFileAuto('Team/new.md','New'),/observation-required/);
 assert.equal(await f.live.getStub('Team/new.md'),null);await f.live.writeFileAuto('Team/new.md','New');
 assert.equal((await f.read('Team/new.md')).toString(),'New');
 await assert.rejects(f.live.getStub('Team/../private.md'),/outside-mount/);
 await assert.rejects(f.live.getStub('Private/note.md'),/outside-mount/);
});
test('native case correction preserves bytes and refuses a host-reported distinct target',async t=>{
 const f=await liveStorage(t);await f.write('Team/note.md',Buffer.from('Preserved'));
 const stub=await f.live.getStub('Team/note.md');await f.live.renameFile(stub,'Team/NOTE.md');
 assert.equal((await f.read('Team/NOTE.md')).toString(),'Preserved');
 const renamed=await f.live.getStub('Team/NOTE.md'),getStub=f.storage.getStub;
 // Case-sensitive hosts can contain both names. Simulate that host response
 // even when this test runs on a case-insensitive macOS filesystem.
 f.storage.getStub=async name=>name==='Team/note.md'?{...renamed,path:name}:getStub(name);
 await assert.rejects(f.live.renameFile(renamed,'Team/note.md'),/case-collision/);
 assert.equal((await f.read('Team/NOTE.md')).toString(),'Preserved');
});
