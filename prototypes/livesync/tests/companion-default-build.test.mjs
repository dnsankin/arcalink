import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchIdbMemory} from '../scripts/patch-idb-memory.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),source=path.join(root,'.cache/source');

test('fresh default bundle excludes companion migration graph while retaining independent actions',async()=>{
 const meta=JSON.parse(await readFile(path.join(source,'meta-prod.json'),'utf8'));
 const inputs=Object.keys(meta.inputs);
 assert.ok(inputs.some(name=>name.endsWith('/companion-actions.ts')));
 assert.ok(inputs.some(name=>name.endsWith('/companion-action-codec.ts')));
 assert.ok(inputs.some(name=>name.endsWith('/companion-ownership.ts')));
 assert.deepEqual(inputs.filter(name=>/companion-migration(?:-|\.)/.test(name)),[]);
});

test('fresh build preserves archive KVS and upstream Pouch adapters except the existing memory patch',async t=>{
 const archive=path.join(root,'.cache/source.tar.gz');
 const member=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n').find(name=>name.endsWith('/src/common/KeyValueDBv2.ts'));
 assert.ok(member);assert.equal(await readFile(path.join(source,'src/common/KeyValueDBv2.ts'),'utf8'),execFileSync('tar',['-xOzf',archive,member],{encoding:'utf8'}));
 const dir=await mkdtemp(path.join(tmpdir(),'pouch-upstream-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const adapter of ['idb','indexeddb']){
  const pkg='pouchdb-adapter-'+adapter,installed=path.join(source,'node_modules',pkg),version=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8')).version;
  const tarball=execFileSync('npm',['pack','--offline','--silent',`https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`],{cwd:dir,encoding:'utf8'}).trim().split('\n').at(-1);
  for(const name of ['index.js','index.es.js']){
   const upstream=execFileSync('tar',['-xOzf',path.join(dir,tarball),'package/lib/'+name],{encoding:'utf8'});
   assert.equal(await readFile(path.join(installed,'lib',name),'utf8'),adapter==='idb'?patchIdbMemory(upstream):upstream,pkg+'/'+name);
  }
 }
});
