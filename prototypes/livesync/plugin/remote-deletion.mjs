// A fresh local DB has no tombstones yet. Missing local metadata is therefore
// insufficient permission to recreate an old Telegram item.
export async function remoteDeletionStatus(nativeFetch, connection, id, timeoutMs=8000) {
 let timer;
 try {
  const url=connection.uri.replace(/\/$/,'')+'/'+encodeURIComponent(connection.database)+'/_all_docs';
  const result=await Promise.race([
   (async()=>{
    const response=await nativeFetch(url,{method:'POST',headers:{Authorization:connection.authorization,'Content-Type':'application/json'},body:JSON.stringify({keys:[id],include_docs:true})});
    if(response.status!==200)throw Error('unavailable');
    return await response.json();
   })(),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),timeoutMs);}),
  ]);
  const row=result?.rows?.[0];
  if(result.rows?.length!==1||row?.key!==id)throw Error('invalid response');
  if(row.error==='not_found')return false;
  if(row.error||!row.value?.rev)throw Error('invalid row');
  if(row.value.deleted===true)return true; // CouchDB hard tombstone.
  if(!row.doc||row.doc._id!==id)throw Error('missing document');
  return row.doc.deleted===true||row.doc._deleted===true;
 } catch {
  throw Error('Не удалось проверить удалённые заметки на сервере. Импорт Telegram продолжится после восстановления связи.');
 } finally {clearTimeout(timer);}
}
