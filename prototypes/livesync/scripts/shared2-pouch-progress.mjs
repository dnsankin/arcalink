import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
/** Pinned PouchDB 9 progress bookkeeping starts an unawaited info() promise.
 * Its rejection must not become an unhandled rejection after replication has
 * completed. Main info/changes/document/checkpoint errors remain untouched.
 * This transform is scoped to the isolated shared2 stand/test bundles.
 */
export function patchShared2PouchProgress(source){
 const start='    src.info().then(function (info) {\n      var task = src.activeTasks.get(taskId);';
 const end='    });\n\n    return checkpointer.writeCheckpoint(currentBatch.seq,';
 if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Unexpected pinned PouchDB progress bookkeeping');
 return source.replace(end,'    }).catch(function () { /* shared2: progress only; transfer errors still propagate */ });\n\n    return checkpointer.writeCheckpoint(currentBatch.seq,');
}
export function shared2PouchProgressPlugin(){return {name:'shared2-pouch-progress',setup(build){
 build.onResolve({filter:/^@arcalink\/shared2-engine-encryption$/},async args=>{
  const require=createRequire(join(args.resolveDir,'shared2-resolver.cjs'));
  const entry=require.resolve('@vrtmrz/livesync-commonlib/context',{paths:[join(args.resolveDir,'../.cache/source/node_modules')]});
  const target=join(dirname(entry),'pouchdb/encryption.js'),source=await readFile(target);
  if(createHash('sha256').update(source).digest('hex')!=='34225c4a954cfaa4adde6885976fb9fcd648031797e66117cb2c0d12a996000f')throw Error('Unexpected pinned engine encryption implementation');
  return {path:target};
 });
 build.onLoad({filter:/pouchdb-replication[/\\]lib[/\\]index\.js$/},async args=>({contents:patchShared2PouchProgress(await readFile(args.path,'utf8')),loader:'js'}));}};}
