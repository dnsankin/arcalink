const fail=code=>Object.assign(Error(code),{code});
const methods=new Set(['action.pair','action.hello','action.frame']);
const MAX_WIRE=15*1024;
function wire(value){return !!value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='payload,wire'&&value.wire==='raw'&&typeof value.payload==='string'&&value.payload.length<=MAX_WIRE&&new TextEncoder().encode(value.payload).length<=MAX_WIRE;}
/** Owns only the dedicated action and its RPC handlers, never the shared room. */
export function createPeerActionChannel({room,RpcRoom,subscribePeers,handlers={},onLeave=()=>{}}){
 if(!room||typeof room.makeAction!=='function'||typeof RpcRoom!=='function'||typeof subscribePeers!=='function'||typeof onLeave!=='function')throw fail('action-channel-invalid');
 const action=room.makeAction('arcaact1');let closed=false,receive=null;const active=new Set(),pending=new Set();
 const transport={
  send(message,peerId){if(closed||!wire(message)||typeof peerId!=='string')throw fail('action-wire-invalid');return action.send(message,{target:peerId});},
  onMessage(handler){receive=handler;action.onMessage=(value,context)=>{if(!closed&&wire(value)&&typeof context?.peerId==='string')receive?.(value,context.peerId);};return ()=>{receive=null;action.onMessage=null;};},
  onPeerJoin(handler){return subscribePeers(room,{onJoin:handler});},
  onPeerLeave(handler){return subscribePeers(room,{onLeave:peer=>{onLeave(peer);handler(peer);}});}
 };
 const rpc=new RpcRoom({transport,maxWirePayloadBytes:MAX_WIRE,canAcceptRequest:async(_peer,method)=>!closed&&methods.has(method)});
 for(const method of methods){const fn=handlers[method];if(typeof fn!=='function')continue;rpc.registerCancellable(method,async(context,peer,...args)=>{
  if(closed||context.signal.aborted||active.has(peer)||active.size>=8||args.length!==1)throw fail('action-channel-busy');
  active.add(peer);let finish;const drained=new Promise(resolve=>{finish=resolve;});pending.add(drained);
  try{return await fn(peer,args[0],context.signal);}catch(error){const code=typeof error?.code==='string'&&/^action-[a-z0-9-]{1,80}$/.test(error.code)?error.code:'action-unavailable';throw fail(code);}finally{active.delete(peer);pending.delete(drained);finish();}
 });}
 const close=()=>{if(!closed){closed=true;rpc.close();}};
 return {async call(peer,method,value,options){if(closed||!methods.has(method)||typeof peer!=='string')throw fail('action-channel-invalid');return rpc.invoke(peer,method,[value],options);},close,async closeAndDrain(){close();await Promise.all([...pending]);}};
}
