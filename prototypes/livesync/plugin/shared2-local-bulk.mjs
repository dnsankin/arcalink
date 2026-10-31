/** Shared2 local-cache adapter: repeated identical new chunks need one physical
 * write. Preserve one result per input and never deduplicate revision imports.
 * The pinned memory adapter otherwise recursively processes thousands of
 * duplicate updates in a single batch and can overflow its stack.
 */
export function wrapShared2LocalBulk(database){
 const original=database.bulkDocs.bind(database);
 database.bulkDocs=function(request,options,callback){
  const opts=typeof options==='function'?undefined:options,done=typeof options==='function'?options:callback,docs=Array.isArray(request)?request:request?.docs;
  if(!Array.isArray(docs)||opts?.new_edits===false||request?.new_edits===false)return original(...arguments);
  const unique=[],indices=[],known=new Map();
  for(const doc of docs){
   const eligible=doc&&doc.type==='leaf'&&typeof doc._id==='string'&&doc._id.startsWith('h:')&&typeof doc.data==='string'&&Object.keys(doc).length===3;
   const key=eligible?JSON.stringify([doc._id,doc.data]):null;
   if(key!==null&&known.has(key)){indices.push(known.get(key));continue;}
   indices.push(unique.length);if(key!==null)known.set(key,unique.length);unique.push(doc);
  }
  if(unique.length===docs.length)return original(...arguments);
  const run=original(Array.isArray(request)?unique:{...request,docs:unique},opts).then(rows=>indices.map(index=>({...rows[index]})));
  if(done)run.then(value=>done(null,value),error=>done(error));return run;
 };
 return database;
}
