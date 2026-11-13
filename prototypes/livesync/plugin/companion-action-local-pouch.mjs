/** Read-only HTTP-shaped access to a single local raw Pouch database. */
export const LOCAL_ACTION_ORIGIN='https://companion-local.invalid';
export const LOCAL_ACTION_DATABASE='receiver';
const fail=code=>Object.assign(Error(code),{code});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const allowedId=id=>typeof id==='string'&&id.length>0&&id.length<=4096&&!/[\x00-\x1f\x7f]/.test(id)&&!id.startsWith('_');
export function createLocalPouchFetch(db){
 if(!db||typeof db.get!=='function')throw fail('action-local-db-invalid');
 async function checkChunk(id){if(!id.startsWith('h:'))return;let leaves;try{leaves=await db.get(id,{open_revs:'all'});}catch(e){if(e.status===404)throw fail('action-local-chunk-unavailable');throw e;}if(!Array.isArray(leaves)||leaves.length!==1||!leaves[0].ok||leaves[0].ok._deleted||leaves[0].ok.type!=='leaf')throw fail('action-local-chunk-unavailable');}
 const pending=new Set();let closed=false;
 const fetcher=async (input,options)=>{
  if(closed)throw fail('action-local-closed');
  const request=new Request(input,options),url=new URL(request.url),prefix='/'+LOCAL_ACTION_DATABASE;
  if(url.origin!==LOCAL_ACTION_ORIGIN||url.username||url.password||url.hash||!(url.pathname===prefix||url.pathname.startsWith(prefix+'/')))throw fail('action-local-origin-denied');
  const method=request.method,tail=url.pathname.slice(prefix.length),localParams=tail==='/_local/obsidian_livesync_sync_parameters',parts=localParams?['_local/obsidian_livesync_sync_parameters']:tail&&tail!=='/'?tail.slice(1).split('/'):[];
  if(parts.length>1||parts.some(x=>!x))throw fail('action-local-path-denied');
  let id='';try{if(parts.length)id=decodeURIComponent(parts[0]);}catch{throw fail('action-local-path-denied');}
  if(parts.length&&!localParams&&encodeURIComponent(id).toLowerCase()!==parts[0].toLowerCase())throw fail('action-local-path-denied');
  if(!['GET','HEAD','POST'].includes(method))throw fail('action-local-write-denied');
  if(method==='POST'&&!['_all_docs','_bulk_get','_revs_diff'].includes(id))throw fail('action-local-write-denied');
  if(method!=='POST'&&id&&id!=='_changes'&&id!=='_all_docs'&&!localParams&&!allowedId(id))throw fail('action-local-path-denied');
  try{
   let result;
   if(!id){if(method==='POST'||url.search)throw fail('action-local-path-denied');result=await db.info();}
   else if(id==='_all_docs'&&method==='GET'){const q=url.searchParams;if([...q.keys()].sort().join(',')!=='endkey,limit,startkey'||q.get('limit')!=='2')throw fail('action-local-path-denied');let a,b;try{a=JSON.parse(q.get('startkey'));b=JSON.parse(q.get('endkey'));}catch{throw fail('action-local-path-denied');}if(!['f:','i:f:','ix:f:','ps:f:'].includes(a)||b!==a+'\ufff0')throw fail('action-local-path-denied');result=await db.allDocs({startkey:a,endkey:b,limit:2});}
   else if(id==='_changes'){
    if(method!=='GET')throw fail('action-local-path-denied');const q={};for(const [key,value] of url.searchParams){if(Object.prototype.hasOwnProperty.call(q,key)||!['since','feed','limit','heartbeat','include_docs'].includes(key))throw fail('action-local-path-denied');q[key]=value;}
    if(q.since!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(q.since)||q.feed!==undefined&&!['normal','longpoll'].includes(q.feed)||q.include_docs!==undefined&&!['true','false'].includes(q.include_docs)||q.heartbeat!==undefined&&q.heartbeat!=='10000'||q.limit!==undefined&&(!/^[1-9][0-9]*$/.test(q.limit)||Number(q.limit)>32))throw fail('action-local-path-denied');
    const since=q.since??0,limit=Number(q.limit??25),include_docs=q.include_docs==='true';const page=at=>db.changes({since:at,limit,include_docs,return_docs:true});if(request.signal.aborted)throw new DOMException('Aborted','AbortError');result=await page(since);
    if(q.feed==='longpoll'&&!result.results.length){
     const baseline=result.last_seq;await new Promise((resolve,reject)=>{let done=false,timer,feed;const finish=error=>{if(done)return;done=true;clearTimeout(timer);request.signal.removeEventListener('abort',abort);pending.delete(abort);try{feed?.removeAllListeners();}catch(e){error??=e;}try{feed?.cancel();}catch(e){error??=e;}if(error)reject(error);else resolve();};const abort=()=>finish(new DOMException('Aborted','AbortError'));if(request.signal.aborted){abort();return;}request.signal.addEventListener('abort',abort,{once:true});pending.add(abort);if(closed){abort();return;}timer=setTimeout(()=>finish(),10000);try{feed=db.changes({since:baseline,live:true,include_docs:false,return_docs:false});feed.on('change',()=>finish()).on('error',finish);}catch(e){finish(e);}});if(request.signal.aborted)throw new DOMException('Aborted','AbortError');result=await page(baseline);
    }
   }
   else if(method==='POST'){
    const query={};for(const [key,value] of url.searchParams){if(!Object.prototype.hasOwnProperty.call(query,key)&&['include_docs','conflicts','revs'].includes(key)&&['true','false'].includes(value))query[key]=value==='true';else throw fail('action-local-path-denied');}const raw=await request.text();if(raw.length>8*1024*1024)throw fail('action-local-body-limit');let body;try{body=JSON.parse(raw);}catch{throw fail('action-local-path-denied');}
    if(id==='_all_docs'){if(!body||!Array.isArray(body.keys)||body.keys.length>100000||body.keys.some(x=>!allowedId(x)))throw fail('action-local-path-denied');for(const key of body.keys)await checkChunk(key);result=await db.allDocs({keys:body.keys,include_docs:query.include_docs??!!body.include_docs,conflicts:query.conflicts??!!body.conflicts});}
    else if(id==='_bulk_get'){if(!body||!Array.isArray(body.docs)||body.docs.length>100000||body.docs.some(x=>!x||!allowedId(x.id)))throw fail('action-local-path-denied');for(const item of body.docs)await checkChunk(item.id);result=await db.bulkGet({docs:body.docs,revs:query.revs??!!body.revs});}
    else{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length>100000||Object.keys(body).some(x=>!allowedId(x)))throw fail('action-local-path-denied');result=await db.revsDiff(body);}
   }else{
    const opts={},seen=new Set();for(const [key,value] of url.searchParams){if(seen.has(key))throw fail('action-local-path-denied');seen.add(key);if(key==='open_revs'&&value==='all')opts.open_revs='all';else if(key==='rev'&&/^[1-9][0-9]*-[A-Za-z0-9]+$/.test(value))opts.rev=value;else if(['revs','conflicts','deleted_conflicts','attachments','binary'].includes(key)&&['true','false'].includes(value))opts[key]=value==='true';else throw fail('action-local-path-denied');}
    await checkChunk(id);result=await db.get(id,opts);
   }
   if(request.signal.aborted||closed)throw new DOMException('Aborted','AbortError');return method==='HEAD'?new Response(null,{status:200,headers:{'content-type':'application/json'}}):json(result);
  }catch(error){if(error?.name==='AbortError'||error?.code?.startsWith('action-local-'))throw error;const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;return json({error:error.name||'unknown_error',reason:error.reason||error.message||'database error'},status);}
 };
 fetcher.close=()=>{closed=true;for(const abort of [...pending])abort();};
 return fetcher;
}
