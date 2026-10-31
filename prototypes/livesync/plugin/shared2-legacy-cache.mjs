import {folderPaths,safeRelative} from './folder-model.mjs';
const fail=code=>Object.assign(Error(code),{code});
/** Preserve pending old Yjs text before retiring its persistence/provider. Never
 * pick it over a different native file or a newer shared database implicitly.
 */
export async function preserveShared2LegacyTexts({files,mount,hashStream,diskHash,writeBackup,assertCurrent}){
 const result=[];
 for(const [id,path] of folderPaths(files)){
  await assertCurrent();if(!safeRelative(path))throw fail('shared2-invalid-legacy-cache-path');
  const entry=files.get(id);if(entry?.get('type')!=='text')continue;
  const content=entry.get('content');if(!content||typeof content.toString!=='function'||typeof content.toDelta!=='function'||typeof content.insert!=='function')throw fail('shared2-invalid-legacy-cache-text');
  const text=content.toString(),proof=await hashStream(new Blob([text]).stream());
  if(await diskHash(mount+'/'+path)===proof.sha256)continue;
  const backup=await writeBackup(proof.sha256,text);result.push({path,...proof,backup});
 }
 return result;
}
export async function importShared2LegacyTexts({versions,documentRoot,engine,role,hashStream,readBackup,assertCurrent}){
 if(role==='viewer')return {imported:0,pending:versions.length};
 if(!['owner','editor'].includes(role))throw fail('shared2-invalid-legacy-import-role');
 let imported=0;
 await assertCurrent();const inventory=await engine.inspect();
 for(const version of versions){
  await assertCurrent();if(!safeRelative(version.path)||typeof version.backup!=='string'||!safeRelative(version.backup)||!version.backup.startsWith('ArcaLink Shared/')||!(/^[a-f0-9]{64}$/).test(version.sha256)||!Number.isSafeInteger(version.size)||version.size<0)throw fail('shared2-invalid-legacy-cache-proof');
  const name=documentRoot+'/'+version.path,file=inventory.files.find(file=>file.path===name);let found=false;
  for(const revision of file?[file.revision,...file.conflicts]:[]){const candidate=await engine.readRevision(name,revision);if(!candidate||candidate.deleted)continue;const proof=await hashStream(new Blob([candidate.bytes]).stream());if(proof.sha256===version.sha256&&proof.size===version.size){found=true;break;}}
  if(found)continue;
  const blob=await readBackup(version.backup),proof=await hashStream(blob.stream());if(proof.sha256!==version.sha256||proof.size!==version.size)throw fail('shared2-legacy-cache-backup-changed');
  await assertCurrent();await engine.write(name,{blob,independent:true});imported++;
 }
 if(imported){await assertCurrent();await engine.synchronize();}
 return {imported,pending:0};
}
