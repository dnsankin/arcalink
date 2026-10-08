import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const manifest=JSON.parse(readFileSync('manifest.json','utf8'));
const expected=JSON.parse(readFileSync('prototypes/livesync/community-release.json','utf8'));
const versions=JSON.parse(readFileSync('versions.json','utf8'));
assert.equal(manifest.id,'arcalink-sync');
assert.equal(manifest.version,expected.version);
assert.equal(versions[manifest.version],manifest.minAppVersion);
assert.equal(JSON.parse(readFileSync('package.json','utf8')).version,manifest.version);
execFileSync(process.execPath,['--check','main.js']);
assert.ok(readFileSync('main.js').length>100000);
assert.ok(readFileSync('styles.css').length>0);
const source=readFileSync('prototypes/livesync/plugin/main.ts','utf8');
for(const marker of ['updatePilot','checkPilotUpdate','installRelease','recoverInterruptedUpdate',"id:'updates'",'panels.updates'])assert.equal(source.includes(marker),false,marker);
for(const name of readdirSync('prototypes/livesync/plugin').filter(name=>/\.(ts|mjs)$/.test(name)))
  for(const marker of ['disablePlugin','enablePlugin'])assert.equal(readFileSync('prototypes/livesync/plugin/'+name,'utf8').includes(marker),false,name+': '+marker);
for(const marker of ['disablePlugin','enablePlugin'])assert.equal(readFileSync('main.js','utf8').includes(marker),false,'bundle: '+marker);
console.log('Community metadata, syntax, assets and absence of self-updater/automatic plugin reload verified');
