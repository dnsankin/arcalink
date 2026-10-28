const delimiter = '|[]|';
const prefix = '^(?:';
const suffix = ')(?:/|$)';
const validPath = path => typeof path === 'string' && path.length > 0 && !/[\\\u0000-\u001f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');

// Literal Unicode escapes survive the engine's whitespace stripping and list
// separator. Only this canonical form belongs to the folder picker.
function folderRule(path) {
  return prefix + path.split('').map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + suffix;
}
function ruleFolder(rule) {
  if (!rule.startsWith(prefix) || !rule.endsWith(suffix)) return null;
  const encoded = rule.slice(prefix.length, -suffix.length);
  if (!/^(?:\\u[0-9a-f]{4})+$/.test(encoded)) return null;
  const path = encoded.replace(/\\u([0-9a-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return validPath(path) && folderRule(path) === rule ? path : null;
}
export function excludedFolders(rules = '') {
  return [...new Set(rules.split(delimiter).map(ruleFolder).filter(path => path !== null))];
}
export function folderContains(parent, path, caseSensitive = false) {
  return new RegExp(folderRule(parent), caseSensitive ? '' : 'i').test(path);
}
export function withExcludedFolders(rules, folders, caseSensitive = false) {
  if (!folders.every(validPath)) throw Error('Invalid folder path');
  const selected = [...new Set(folders)].sort((a, b) => a.length - b.length);
  const roots = selected.filter((path, index) => !selected.slice(0, index).some(parent => folderContains(parent, path, caseSensitive)));
  const preserved = (rules || '').split(delimiter).filter(rule => rule && ruleFolder(rule) === null);
  return [...preserved, ...roots.map(folderRule)].join(delimiter);
}

// Only real folder-picker exclusions: never infer whole-folder exclusion from arbitrary regexes.
export function excludedLocalFolderRoots({rules='',common=[],paths=[],caseSensitive=false}) {
 const roots=[...excludedFolders(rules),...common];
 const selected=paths.filter(path=>validPath(path)&&roots.some(root=>folderContains(root,path,caseSensitive)));
 return selected.sort((a,b)=>a.length-b.length||a.localeCompare(b)).filter((path,index,all)=>!all.slice(0,index).some(parent=>folderContains(parent,path,caseSensitive)));
}
export function localFolderCleanupBlock(path,{shared=[],protectedPaths=[],caseSensitive=false}={}) {
 if(!validPath(path))return 'Недопустимый путь папки';
 if([...shared,...protectedPaths].some(root=>folderContains(root,path,caseSensitive)||folderContains(path,root,caseSensitive)))return 'Папка содержит совместные или служебные материалы. Удаление здесь недоступно.';
 return '';
}
export async function trashExcludedLocalFolder(path,{snapshot,getFolder,trash}) {
 const state=snapshot();
 if(!excludedLocalFolderRoots(state).includes(path))throw Error('Папка больше не исключена из синхронизации. Обновите список.');
 const blocked=localFolderCleanupBlock(path,state);if(blocked)throw Error(blocked);
 const folder=getFolder(path);if(!folder)throw Error('Локальная папка уже отсутствует. Обновите список.');
 // No await between the final eligibility check and invoking the native trash operation.
 await trash(folder);
}
