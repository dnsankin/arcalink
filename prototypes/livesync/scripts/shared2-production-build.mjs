import {createRequire} from 'node:module';import {dirname,join} from 'node:path';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {patchShared2PouchProgress} from './shared2-pouch-progress.mjs';
/** Production alias only: never onLoad/patch the personal replication module. */
export function shared2ProductionPlugin(){return {name:'arcalink-shared2-isolated-engine',setup(build){
 build.onResolve({filter:/^@arcalink\/shared2-engine-encryption$/},async args=>{
  const require=createRequire(join(args.resolveDir,'shared2-resolver.cjs')),entry=require.resolve('@vrtmrz/livesync-commonlib/context',{paths:[join(args.resolveDir,'../.cache/source/node_modules')]}),target=join(dirname(entry),'pouchdb/encryption.js'),source=await readFile(target);
  if(createHash('sha256').update(source).digest('hex')!=='34225c4a954cfaa4adde6885976fb9fcd648031797e66117cb2c0d12a996000f')throw Error('Unexpected pinned engine encryption implementation');return {path:target};
 });
 // Stable virtual IDs keep machine-specific paths out of emitted module names.
 build.onResolve({filter:/^@arcalink\/shared2-pouch-core$/},args=>{const require=createRequire(join(args.resolveDir,'shared2-resolver.cjs'));return {path:'pouchdb-core',namespace:'shared2-core',pluginData:{entry:require.resolve('pouchdb-core',{paths:[join(args.resolveDir,'../.cache/source/node_modules')]})}};});
 build.onLoad({filter:/.*/,namespace:'shared2-core'},async args=>({contents:await readFile(args.pluginData.entry,'utf8'),loader:'js',resolveDir:dirname(args.pluginData.entry)}));
 build.onResolve({filter:/.*/,namespace:'shared2-core'},args=>build.resolve(args.path,{resolveDir:args.resolveDir,kind:args.kind,namespace:'file'}));
 build.onResolve({filter:/^@arcalink\/shared2-pouch-replication$/},args=>{const require=createRequire(join(args.resolveDir,'shared2-resolver.cjs'));return {path:'pouchdb-replication',namespace:'shared2-replication',pluginData:{entry:require.resolve('pouchdb-replication',{paths:[join(args.resolveDir,'../.cache/source/node_modules')]})}};});
 build.onLoad({filter:/.*/,namespace:'shared2-replication'},async args=>({contents:patchShared2PouchProgress(await readFile(args.pluginData.entry,'utf8')),loader:'js',resolveDir:dirname(args.pluginData.entry)}));
 build.onResolve({filter:/.*/,namespace:'shared2-replication'},args=>build.resolve(args.path,{resolveDir:args.resolveDir,kind:args.kind,namespace:'file'}));
}};}
