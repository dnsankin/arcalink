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
