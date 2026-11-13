import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {packMessageCatalog} from '../scripts/packed-message-catalog.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),source=root+'.cache/source/';
const require=createRequire(source+'package.json'),typescript=require('typescript'),esbuild=require('esbuild');
const normalized=value=>JSON.parse(JSON.stringify(value));
function original(text,kind){
 const context={module:{exports:{}},exports:{}};
 vm.runInNewContext(esbuild.transformSync(text,{loader:kind==='engine'?'ts':'js',format:'cjs',target:'es2018'}).code,context);
 return normalized(kind==='engine'?context.module.exports.allMessages:context.module.exports.default);
}
async function restored(packed,kind){
 const output=await esbuild.build({stdin:{contents:packed.source,loader:kind==='engine'?'ts':'js',resolveDir:source},bundle:true,write:false,platform:'browser',format:'cjs',target:'es2018',metafile:true});
 // A CJS export is used only by this host test; the restored module itself
 // depends solely on fflate's browser entry and browser globals.
 const context={module:{exports:{}},exports:{},atob,TextDecoder,TextEncoder,Uint8Array};
 vm.runInNewContext(output.outputFiles[0].text,context);
 assert.ok(Object.keys(output.metafile.inputs).some(path=>path.endsWith('fflate/esm/browser.js')));
 assert.equal(Object.keys(output.metafile.inputs).some(path=>/fflate\/.*(?:node|index\.mjs)/.test(path)),false);
 return normalized(kind==='engine'?context.module.exports.allMessages:context.module.exports.default);
}
async function upstream(relative){try{return await readFile(source+relative+'.packing-upstream','utf8');}catch(error){if(error.code!=='ENOENT')throw error;return readFile(source+relative,'utf8');}}
for(const [kind,relative] of [['engine','src/common/messages/combinedMessages.prod.ts'],['supplemental','src/message-catalog.mjs']])test(kind+' packed catalogue preserves every value and insertion order synchronously',async()=>{
 const input=await upstream(relative),expected=original(input,kind),packed=packMessageCatalog(input,{typescript,kind}),actual=await restored(packed,kind);
 assert.deepEqual(actual,expected);assert.equal(JSON.stringify(actual),JSON.stringify(expected));
 assert.equal(packed.stats.keys,Object.keys(expected).length);assert.ok(packed.stats.keys>100);assert.ok(packed.stats.packedBytes<packed.stats.rawBytes/2);
 assert.equal(packMessageCatalog(input,{typescript,kind}).source,packed.source);
 if(kind==='engine')assert.deepEqual([...new Set(Object.values(actual).flatMap(Object.keys))].sort(),['def','es','fr','he','ja','ko','ru','zh','zh-tw']);
});

const declaration='export const allMessages: Readonly<Record<string, Readonly<Record<string, string>>>> = ';
test('literal Unicode, empty strings, placeholders and escaped data remain exact',async()=>{
 const data={'q\"\\\n':{def:'',ru:'\uFEFFПривет 😀\r\n${path} %{value} $&',ja:'\uD800\u0000'},other:{def:'same'}};
 const input=declaration+JSON.stringify(data)+';',packed=packMessageCatalog(input,{typescript,kind:'engine'});
 assert.deepEqual(await restored(packed,'engine'),data);
});
test('supplemental duplicate rows retain first position and last value with aliases',async()=>{
 const input='export default Object.fromEntries([["first","old"],["second","two"],["first","new","${user}","😀"]].map(([def,ru,...aliases])=>[def,{def,ru,...Object.fromEntries(aliases.map((value,i)=>[\'alias\'+i,value]))}]));';
 const actual=await restored(packMessageCatalog(input,{typescript,kind:'supplemental'}),'supplemental');
 assert.deepEqual(Object.keys(actual),['first','second']);assert.deepEqual(actual.first,{def:'first',ru:'new',alias0:'${user}',alias1:'😀'});
});
test('supplemental export retains its dictionary type for TypeScript consumers',async()=>{
 const packed=packMessageCatalog(await upstream('src/message-catalog.mjs'),{typescript,kind:'supplemental'});
 const modulePath=source+'packing-typed.mjs',consumerPath=source+'packing-consumer.ts';
 const files=new Map([[modulePath,packed.source],[consumerPath,"import catalog from './packing-typed.mjs';\nconst rows=Object.entries(catalog).map(([key,row])=>({def:key,...row}));\nrows[0].def.toUpperCase();"]]);
 const options={allowJs:true,noEmit:true,skipLibCheck:true,target:typescript.ScriptTarget.ES2022,module:typescript.ModuleKind.ESNext,moduleResolution:typescript.ModuleResolutionKind.Bundler};
 const host=typescript.createCompilerHost(options),read=host.readFile,exists=host.fileExists,get=host.getSourceFile;
 host.readFile=path=>files.has(path)?files.get(path):read(path);host.fileExists=path=>files.has(path)||exists(path);
 host.getSourceFile=(path,version,...args)=>files.has(path)?typescript.createSourceFile(path,files.get(path),version,true,path.endsWith('.mjs')?typescript.ScriptKind.JS:typescript.ScriptKind.TS):get(path,version,...args);
 const program=typescript.createProgram([consumerPath],options,host),diagnostics=typescript.getPreEmitDiagnostics(program);
 assert.deepEqual(diagnostics.map(d=>typescript.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
});
for(const body of ['{"x":{def:(globalThis.executed=true)}}','{"x":{def:"a",...other}}','{["x"]:{def:"a"}}','{"__proto__":{def:"a"}}','{1e2:{def:"a"}}','{"x":{def:"a"},"x":{def:"b"}}','{"x":{def:"unterminated}}'])test('rejects nonstatic or ambiguous catalogue '+body.slice(0,35),()=>{
 assert.throws(()=>packMessageCatalog(declaration+body+';',{typescript,kind:'engine'}),/Unexpected static/);
});
test('unknown supplemental transformations and extra module statements fail closed',()=>{
 const body='export default Object.fromEntries([["a","b"]].map(row=>row));';
 assert.throws(()=>packMessageCatalog(body,{typescript,kind:'supplemental'}));
 assert.throws(()=>packMessageCatalog(declaration+'{};globalThis.executed=true;',{typescript,kind:'engine'}));
});
