import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// These permissive licenses allow commercial use. Other licenses require review.
export const allowed = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause',
  'BSD-3-Clause', '0BSD', 'Unlicense', 'BlueOak-1.0.0', '(WTFPL OR MIT)', '(MIT OR CC0-1.0)']);

export async function auditBundle(source) {
  const meta = JSON.parse(await readFile(path.join(source, 'meta-prod.json'), 'utf8'));
  const packages = new Map();
  for (const input of Object.keys(meta.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(source, input.replace(/^(?:shared2-core|shared2-replication):/,'')));
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name && pkg.version) { packages.set(dir, pkg); break; }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      dir = path.dirname(dir);
    }
  }
  const inventory = [];
  let notices = await readFile(path.join(source, 'LICENSE'), 'utf8');
  for (const [dir, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    if (!allowed.has(pkg.license)) throw new Error(`License review required: ${pkg.name}: ${pkg.license}`);
    const files = (await readdir(dir)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license });
    notices += `\n\n===== ${pkg.name}@${pkg.version} (${pkg.license}) =====\n`;
    // These published packages omit a standalone LICENSE. Preserve their source
    // attribution and include the declared license text rather than omit notices.
    if (!files.length) {
      if (pkg.name === 'pouchdb-wrappers' && pkg.version === '5.0.0') {
        notices += 'Author: Marten de Vries. Published package declares Apache-2.0.\n';
        notices += await readFile(path.join(source, 'node_modules/pouchdb-core/LICENSE'), 'utf8');
      } else if (pkg.name === 'qrcode-generator' && pkg.version === '1.5.2') {
        const code = await readFile(path.join(dir, 'qrcode.js'), 'utf8');
        if (!code.includes('Copyright (c) 2009 Kazuhiko Arase') || !code.includes('MIT license')) {
          throw new Error('Unexpected qrcode-generator attribution');
        }
        notices += code.slice(0, code.indexOf('var qrcode'));
        const mit = await readFile(path.join(source, 'LICENSE'), 'utf8');
        notices += mit.replace('Copyright (c) 2021 vorotamoroz', 'Copyright (c) 2009 Kazuhiko Arase');
      } else throw new Error(`License text missing: ${pkg.name}`);
    }
    for (const file of files) notices += await readFile(path.join(dir, file), 'utf8');
  }
  return { inventory, notices };
}
