/** Durable client job admission. Closing a view never cancels server work. */
const fail=code=>Object.assign(Error(code),{code});
export function createShared2Jobs({request,store,scope,onChange=(_state)=>{}}){
 if(typeof request!=='function'||!store||typeof store.load!=='function'||typeof store.save!=='function'||!scope?.account||!scope?.workspace)throw fail('shared2-job-adapters-required');
 let state,loading,queue=Promise.resolve(),closed=false;const admissions=new Map();
 const validId=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
 const emit=()=>onChange(structuredClone(state));
 async function load(){if(state)return state;if(loading)return loading;loading=(async()=>{const saved=await store.load();if(saved&&(saved.account!==scope.account||saved.workspace!==scope.workspace||saved.protocol!==2||!Array.isArray(saved.requests)))throw fail('shared2-job-scope-mismatch');state=saved||{protocol:2,...scope,requests:[],jobs:[]};return state;})();try{return await loading;}finally{loading=undefined;}}
 const mutate=fn=>{const work=queue.then(async()=>{await load();await fn();await store.save(structuredClone(state));emit();});queue=work.catch(()=>{});return work;};
 async function call(path,method='GET',body){const response=await request(path,{method,...(body?{body:JSON.stringify(body)}:{})});if(![200,202].includes(response.status)||!response.json)throw fail(response.json?.error||'shared2-jobs-unavailable');return response.json;}
 function validJob(job){if(!job||!validId(job.id)||!validId(job.folder)||job.workspace!==scope.workspace||!['queued','preparing','copying','verifying','activating','cleaning','completed','cancelled','error'].includes(job.state)||!Number.isSafeInteger(job.done)||!Number.isSafeInteger(job.total)||job.done<0||job.total<job.done)throw fail('shared2-invalid-job-status');return structuredClone(job);}
 async function admit(folder){
  if(closed||!validId(folder))throw fail('shared2-job-admission-invalid');
  if(admissions.has(folder))return admissions.get(folder);
  const task=(async()=>{
   let record;
   // Persist the idempotency key before sending any request. A lost response is
   // retried with the same key after process/device restart.
   await mutate(()=>{record=state.requests.find(row=>row.folder===folder&&!row.terminal);if(!record){record={folder,requestKey:crypto.randomUUID().replaceAll('-',''),terminal:false};state.requests.push(record);}});
   const job=validJob(await call('/shared2/jobs','POST',{folder,workspace:scope.workspace,requestKey:record.requestKey}));
   await mutate(()=>{record.job=job.id;state.jobs=(state.jobs||[]).filter(row=>row.id!==job.id).concat(job);});return job;
  })();admissions.set(folder,task);try{return await task;}finally{admissions.delete(folder);}
 }
 async function refresh(){
  if(closed)throw fail('shared2-jobs-closed');
  const response=await call('/shared2/jobs');if(!Array.isArray(response.jobs))throw fail('shared2-invalid-job-status');
  const jobs=response.jobs.filter(row=>row.workspace===scope.workspace).map(validJob);
  await mutate(()=>{state.jobs=jobs;for(const record of state.requests){const job=jobs.find(row=>row.id===record.job);if(job&&['completed','cancelled'].includes(job.state))record.terminal=true;}});
  return jobs;
 }
 async function action(id,name){if(closed||!validId(id)||!['retry','cancel'].includes(name))throw fail('shared2-invalid-job-action');const job=validJob(await call('/shared2/jobs/'+id+'/'+name,'POST',{}));await mutate(()=>{state.jobs=(state.jobs||[]).filter(row=>row.id!==id).concat(job);});return job;}
 return {admit,refresh,retry:id=>action(id,'retry'),cancel:id=>action(id,'cancel'),async snapshot(){await load();return structuredClone(state);},async close(){closed=true;await queue;}};
}
