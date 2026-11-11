import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { PREPARE_OVERRIDES, prepareModule } from '../src/prepare.js';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const root = realpathSync(
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
    mkdtempSync(nodePath.join(tmpdir(), 'nuxt-prepare-test-')),
  );
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
    mkdirSync(nodePath.dirname(nodePath.join(root, path)), { recursive: true });
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
    writeFileSync(nodePath.join(root, path), content);
  }
  return root;
}
afterEach(() => {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `@nuxt/cli` at `dir` that records how `prepare` was run (as `name`) and writes what it would. */
function fakeCli(dir: string, name: string, body = ''): Record<string, string> {
  return {
    [`${dir}/package.json`]: JSON.stringify({
      name: '@nuxt/cli',
      type: 'module',
      exports: { '.': './index.mjs' },
    }),
    [`${dir}/index.mjs`]: [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'export async function runCommand(command, [cwd], { overrides }) {',
      body,
      `  await writeFile(join(cwd, "loaded.json"), JSON.stringify({ cli: ${JSON.stringify(name)}, command, cwd, overrides, modules: overrides.modules.map((m) => typeof m) }));`,
      "  await mkdir(join(cwd, '.nuxt'), { recursive: true });",
      "  await writeFile(join(cwd, '.nuxt/tsconfig.json'), '{}');",
      '}',
    ].join('\n'),
  };
}

const loaded = (root: string) =>
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  JSON.parse(readFileSync(nodePath.join(root, 'loaded.json'), 'utf8'));

describe('prepareModule', () => {
  it("writes the module's .nuxt types", async () => {
    const root = tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    expect(
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
      readFileSync(nodePath.join(root, '.nuxt/tsconfig.json'), 'utf8'),
    ).toBe('{}');
  }, 30_000);

  it("runs nuxi prepare in the module with nuxt-module-build's overrides", async () => {
    const root = tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    const { command, cwd, overrides } = loaded(root);
    expect([command, cwd, { ...overrides, modules: null }]).toEqual([
      'prepare',
      root,
      { ...PREPARE_OVERRIDES, modules: null },
    ]);
  }, 30_000);

  it('installs the module itself, plus a hook that writes every app template', async () => {
    const root = tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    const { overrides, modules } = loaded(root);
    expect([overrides.modules[0], modules]).toEqual([
      nodePath.join(root, 'src/module.ts'),
      ['string', 'function'],
    ]);
  }, 30_000);

  it('runs the nuxi the installed nuxt comes with', async () => {
    const root = tree({
      'package.json': '{}',
      'node_modules/nuxt/package.json': JSON.stringify({ name: 'nuxt' }),
      ...fakeCli('node_modules/nuxt/node_modules/@nuxt/cli', "nuxt's"),
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    expect(loaded(root).cli).toBe("nuxt's");
  }, 30_000);

  it('fails naming what to install without nuxi', async () => {
    const root = tree({ 'package.json': '{}' });
    await expect(prepareModule(root, 'src/module.ts')).rejects.toThrow(
      /installed in/,
    );
  });

  it("fails with Nuxt's output when the module cannot be loaded", async () => {
    const root = tree({
      'package.json': '{}',
      ...fakeCli(
        'node_modules/@nuxt/cli',
        'own',
        '  throw new Error("module setup failed");',
      ),
    });
    await expect(prepareModule(root, 'src/module.ts')).rejects.toThrow(
      /module setup failed/,
    );
  }, 30_000);
});
