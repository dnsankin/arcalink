import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../plugin/companion-proof.mjs';
import {validateAssistantRelease,boundedOfficialGet,verifyAssistantApk} from '../plugin/assistant-download.mjs';
const bytes=new TextEncoder().encode('test-apk');
const release={schema:1,package:'ru.arcalink.companion',version:'0.1.0',versionCode:1,size:bytes.length,sha256:await sha256(bytes),
 signingCertificateSha256:'a'.repeat(64),filename:'ArcaLink-Android-0.1.0.apk',url:'https://arcalink.ru/downloads/android/ArcaLink-Android-0.1.0.apk',releasedAt:'2026-10-27T00:00:00Z',changes:'Widgets'};
test('valid metadata and exact bytes pass',async()=>{assert.equal(validateAssistantRelease(release),release);assert.equal(await verifyAssistantApk(release,bytes),true);});
test('corrupt/truncated APK never passes integrity check',async()=>{
 await assert.rejects(verifyAssistantApk(release,new TextEncoder().encode('bad')),/проверку/);
 await assert.rejects(verifyAssistantApk(release,new TextEncoder().encode('fake-apk')),/проверку/);
});
test('metadata cannot select arbitrary host, package, filename or future release',()=>{
 for(const extra of [{package:'old.installer'},{url:'https://evil.invalid/app.apk'},{filename:'../../evil.apk'},{releasedAt:'2999-01-01T00:00:00Z'},{size:100000000},{versionCode:0}])assert.throws(()=>validateAssistantRelease({...release,...extra}));
});
test('only the official HTTPS origin is contacted and redirects are forbidden',async()=>{
 let called=false;await assert.rejects(boundedOfficialGet('https://evil.invalid/downloads/android/a',10,{fetcher:async()=>{called=true;}}));assert.equal(called,false);
 await assert.rejects(boundedOfficialGet(release.url,100,{fetcher:async(url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return {ok:true,redirected:true};}}));
});
test('stream limit applies even without Content-Length',async()=>{
 const fetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(12));controller.close();}}));
 await assert.rejects(boundedOfficialGet(release.url,5,{fetcher}),/большой/);
});
test('cancel signal reaches the request and successful stream is preserved',async()=>{
 const controller=new AbortController();const result=await boundedOfficialGet(release.url,bytes.length,{signal:controller.signal,fetcher:async(url,options)=>{assert.equal(options.signal,controller.signal);return new Response(bytes);}});
 assert.deepEqual(new Uint8Array(result),bytes);
});
