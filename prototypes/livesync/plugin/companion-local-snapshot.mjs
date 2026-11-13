import {canonicalOwnership,ownershipIdentity,ownershipDigest} from './companion-ownership-model.mjs';

const fail=()=>Object.assign(Error('ownership-local-snapshot-invalid'),{code:'ownership-local-snapshot-invalid'});
const bytes=value=>new TextEncoder().encode(canonicalOwnership(value));
const encode=value=>{let text='';for(let i=0;i<value.length;i+=16384)text+=String.fromCharCode(...value.subarray(i,i+16384));return btoa(text);};
const decode=value=>{if(typeof value!=='string'||value.length>12*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail();return Uint8Array.from(atob(value),char=>char.charCodeAt(0));};
async function key(value,usage){
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail();
 return crypto.subtle.importKey('raw',Uint8Array.from(value.match(/../g),byte=>parseInt(byte,16)),{name:'AES-GCM'},false,[usage]);
}
export async function localSnapshotKey(secret,identity){
 if(typeof secret!=='string'||secret.length<20)throw fail();
 const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,bytes({purpose:'arcalink-local-snapshot-key-v1',...ownershipIdentity(identity)}))),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function sealLocalPage(identity,sequence,index,documents,secret){
 const context={...ownershipIdentity(identity),purpose:'arcalink-local-snapshot-v1',sequence,index};
 const plaintext=bytes({documents}),iv=crypto.getRandomValues(new Uint8Array(12));
 if(plaintext.length>5*1024*1024)throw fail();
 try{return {context,iv:encode(iv),ciphertext:encode(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:bytes(context)},await key(secret,'encrypt'),plaintext)))};}
 finally{plaintext.fill(0);}
}
export async function openLocalPage(manifest,index,envelope,secret){
 const expected={...ownershipIdentity(manifest),purpose:'arcalink-local-snapshot-v1',sequence:manifest.source.sequence,index};
 const descriptor=manifest.localSnapshot?.pages[index];
 if(!descriptor||canonicalOwnership(expected)!==canonicalOwnership(envelope.context)||await ownershipDigest(envelope)!==descriptor.sha256||bytes(envelope).length!==descriptor.size)throw fail();
 let plaintext;
 try{plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:bytes(expected)},await key(secret,'decrypt'),decode(envelope.ciphertext)));
  const result=JSON.parse(new TextDecoder().decode(plaintext));if(!Array.isArray(result.documents))throw fail();return result.documents;
 }catch{throw fail();}finally{plaintext?.fill(0);}
}
/** Size-bounded transport, independent of the number of chunks in one note. */
export function localDocumentPages(documents){
 const pages=[];let page=[],size=0;
 for(const doc of documents){const length=bytes(doc).length;if(length>4*1024*1024)throw fail();if(size+length>256*1024&&page.length){pages.push(page);page=[];size=0;}page.push(doc);size+=length+1;}
 if(page.length)pages.push(page);return pages;
}
