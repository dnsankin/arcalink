import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const fail=()=>Error('Unexpected static message catalogue shape');
const supplementalTail=".map(([def,ru,...aliases])=>[def,{def,ru,...Object.fromEntries(aliases.map((value,i)=>['alias'+i,value]))}]));";

/** Build-only packing of data, never executable code. Both catalogue APIs and
 * insertion order stay unchanged; the browser restores the data synchronously. */
export function packMessageCatalog(source,{typescript:ts,kind}){
 if(typeof source!=='string'||!ts||!['engine','supplemental'].includes(kind))throw fail();
 const file=ts.createSourceFile('messages.'+(kind==='engine'?'ts':'mjs'),source,ts.ScriptTarget.Latest,true,kind==='engine'?ts.ScriptKind.TS:ts.ScriptKind.JS);
 if(file.parseDiagnostics.length||file.statements.length!==1)throw fail();
 const statement=file.statements[0];let catalog,prefix;
 const string=node=>{if(!ts.isStringLiteral(node)&&!ts.isNoSubstitutionTemplateLiteral(node))throw fail();return node.text;};
 const name=node=>{if(ts.isIdentifier(node)||ts.isStringLiteral(node))return node.text;throw fail();};
 function record(node,leaf=false){
  if(!node||!ts.isObjectLiteralExpression(node))throw fail();const result={};
  for(const property of node.properties){
   if(!ts.isPropertyAssignment(property))throw fail();const key=name(property.name);
   if(['__proto__','constructor','prototype'].includes(key)||Object.hasOwn(result,key))throw fail();
   result[key]=leaf?string(property.initializer):record(property.initializer,true);
  }
  return result;
 }
 if(kind==='engine'){
  if(!ts.isVariableStatement(statement)||statement.modifiers?.length!==1||statement.modifiers[0].kind!==ts.SyntaxKind.ExportKeyword||!(statement.declarationList.flags&ts.NodeFlags.Const)||statement.declarationList.declarations.length!==1)throw fail();
  const declaration=statement.declarationList.declarations[0];
  if(!ts.isIdentifier(declaration.name)||declaration.name.text!=='allMessages'||declaration.type?.getText(file).replace(/\s/g,'')!=='Readonly<Record<string,Readonly<Record<string,string>>>>')throw fail();
  catalog=record(declaration.initializer);prefix=source.slice(0,declaration.initializer.getStart(file));
 }else{
  if(!ts.isExportAssignment(statement)||statement.isExportEquals)throw fail();
  const array=statement.expression.arguments?.[0]?.expression?.expression;
  if(!array||!ts.isArrayLiteralExpression(array)||source.slice(statement.getStart(file),array.getStart(file))!=='export default Object.fromEntries('||source.slice(array.end).trim()!==supplementalTail)throw fail();
  const rows=array.elements.map(row=>{if(!ts.isArrayLiteralExpression(row)||row.elements.length<2)throw fail();return row.elements.map(string);});
  catalog=Object.fromEntries(rows.map(([def,ru,...aliases])=>[def,{def,ru,...Object.fromEntries(aliases.map((value,i)=>['alias'+i,value]))}]));
  prefix=source.slice(0,statement.getStart(file))+'export default ';
 }
 const raw=Buffer.from(JSON.stringify(catalog),'utf8'),packed=deflateSync(raw,{level:9}),base64=packed.toString('base64');
 const restored='JSON.parse(strFromU8(unzlibSync(Uint8Array.from(atob('+JSON.stringify(base64)+'),c=>c.charCodeAt(0)))))';
 const expression=kind==='supplemental'?'/** @type {Record<string, Record<string,string>>} */ ('+restored+')':restored;
 return {source:"import {unzlibSync,strFromU8} from 'fflate/browser';\n"+prefix+expression+';\n',stats:{keys:Object.keys(catalog).length,strings:Object.values(catalog).reduce((n,row)=>n+Object.keys(row).length,0),rawBytes:raw.length,packedBytes:packed.length,sha256:createHash('sha256').update(raw).digest('hex')}};
}
