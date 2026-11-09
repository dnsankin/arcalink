import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) throw new Error(`Unexpected upstream unit test source: ${original}`);
  return source.replace(original, replacement);
}

export async function prepareUnitTests(root, source) {
  const configPath = path.join(source, 'vitest.config.unit.ts');
  const config = await readFile(configPath, 'utf8');
  const configImport = 'import { defineConfig, mergeConfig } from "vitest/config";';
  const obsidianAlias = '                obsidian: "",';
  await writeFile(configPath, replaceOnce(replaceOnce(config, configImport,
    'import { fileURLToPath } from "node:url";\n' + configImport), obsidianAlias,
    '                "arcalink-native-obsidian": fileURLToPath(new URL("./test/obsidian-unit-host.mjs", import.meta.url)),\n' + obsidianAlias));
  await copyFile(path.join(root, 'tests/obsidian-unit-host.mjs'), path.join(source, 'test/obsidian-unit-host.mjs'));

  const p2pTestPath = path.join(source, 'src/serviceFeatures/useP2PReplicatorUI.unit.spec.ts');
  let p2pTest = await readFile(p2pTestPath, 'utf8');
  p2pTest = replaceOnce(p2pTest, 'import { describe, expect, it, vi } from "vitest";',
    'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";');
  const suite = 'describe("useP2PReplicatorUI commands", () => {';
  p2pTest = replaceOnce(p2pTest, suite, suite + `
    beforeEach(() => vi.stubGlobal("window", new EventTarget()));
    afterEach(() => vi.unstubAllGlobals());`);
  p2pTest = replaceOnce(p2pTest, `        eventHub.emitEvent(EVENT_REQUEST_OPEN_P2P);
        await vi.waitFor(() => expect(showWindowOnRight).toHaveBeenCalledWith("p2p-status"));`, `        const dispatch = vi.spyOn(window, "dispatchEvent");
        eventHub.emitEvent(EVENT_REQUEST_OPEN_P2P);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: "arcalink-open-vault-controls",
        })));
        expect(showWindowOnRight).not.toHaveBeenCalled();`);
  await writeFile(p2pTestPath, p2pTest);

  // The plugin build intentionally disables dependency scripts. CLI tests
  // exercise the actual legacy LevelDB binding, which lacks a macOS ARM prebuild.
  const packagePath = path.join(source, 'package.json');
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  metadata.scripts['pretest:unit'] = 'npm rebuild --ignore-scripts=false ./node_modules/level/node_modules/leveldown';
  await writeFile(packagePath, JSON.stringify(metadata, null, 2) + '\n');
}
