import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { PREPARE_OVERRIDES, prepareModule } from '../src/prepare.js';
import { isRecord } from '../src/is-record.js';

const INSTALLED_IN_PATTERN = /installed in/u;
const MODULE_SETUP_FAILED_PATTERN = /module setup failed/u;

const directories: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(
    await mkdtemp(nodePath.join(tmpdir(), 'nuxt-prepare-test-')),
  );
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(nodePath.dirname(nodePath.join(root, path)), {
      recursive: true,
    });
    await writeFile(nodePath.join(root, path), content);
  }
  return root;
}
afterEach(async () => {
  for (const d of directories.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

/** A fake `@nuxt/cli` at `dir` that records how `prepare` was run (as `name`) and writes what it would. */
function fakeCli(dir: string, name: string, body = '') {
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

/** What the fake nuxi recorded about the run it was asked to do. */
interface LoadedState {
  cli: string;
  command: unknown;
  cwd: string;
  overrides: { modules: unknown[] };
  modules: string[];
}

/** Whether a parsed `loaded.json` has the shape of {@link LoadedState}. */
function isLoadedState(value: unknown): value is LoadedState {
  if (!isRecord(value) || !isRecord(value.overrides)) {
    return false;
  }
  return (
    typeof value.cli === 'string' &&
    typeof value.cwd === 'string' &&
    Array.isArray(value.modules) &&
    Array.isArray(value.overrides.modules)
  );
}

const loaded = async (root: string): Promise<LoadedState> => {
  const state: unknown = JSON.parse(
    await readFile(nodePath.join(root, 'loaded.json'), 'utf8'),
  );
  if (!isLoadedState(state)) {
    throw new TypeError(
      'the fake nuxi recorded a state of an unexpected shape',
    );
  }
  return state;
};

describe('prepareModule', () => {
  it("writes the module's .nuxt types", async () => {
    const root = await tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    expect(
      await readFile(nodePath.join(root, '.nuxt/tsconfig.json'), 'utf8'),
    ).toBe('{}');
  }, 30_000);

  it("runs nuxi prepare in the module with nuxt-module-build's overrides", async () => {
    const root = await tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    const { command, cwd, overrides } = await loaded(root);
    expect([command, cwd, { ...overrides, modules: null }]).toEqual([
      'prepare',
      root,
      { ...PREPARE_OVERRIDES, modules: null },
    ]);
  }, 30_000);

  it('installs the module itself, plus a hook that writes every app template', async () => {
    const root = await tree({
      'package.json': '{}',
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    const { overrides, modules } = await loaded(root);
    expect([overrides.modules[0], modules]).toEqual([
      nodePath.join(root, 'src/module.ts'),
      ['string', 'function'],
    ]);
  }, 30_000);

  it('runs the nuxi the installed nuxt comes with', async () => {
    const root = await tree({
      'package.json': '{}',
      'node_modules/nuxt/package.json': JSON.stringify({ name: 'nuxt' }),
      ...fakeCli('node_modules/nuxt/node_modules/@nuxt/cli', "nuxt's"),
      ...fakeCli('node_modules/@nuxt/cli', 'own'),
    });
    await prepareModule(root, 'src/module.ts');
    const state = await loaded(root);
    expect(state.cli).toBe("nuxt's");
  }, 30_000);

  it('fails naming what to install without nuxi', async () => {
    const root = await tree({ 'package.json': '{}' });
    await expect(prepareModule(root, 'src/module.ts')).rejects.toThrow(
      INSTALLED_IN_PATTERN,
    );
  });

  it("fails with Nuxt's output when the module cannot be loaded", async () => {
    const root = await tree({
      'package.json': '{}',
      ...fakeCli(
        'node_modules/@nuxt/cli',
        'own',
        '  throw new Error("module setup failed");',
      ),
    });
    await expect(prepareModule(root, 'src/module.ts')).rejects.toThrow(
      MODULE_SETUP_FAILED_PATTERN,
    );
  }, 30_000);
});
