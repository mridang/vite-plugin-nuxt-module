import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  isModulePackage,
  namesFile,
  readPackageJson,
} from '../src/package-json.js';

async function packageRoot(pkg: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'vite-package-json-'));
  await writeFile(nodePath.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

describe('readPackageJson', () => {
  it("reads the package's manifest", async () => {
    const awaited1 = await readPackageJson(await packageRoot({ name: 'x' }));
    expect(awaited1.name).toBe('x');
  });
});

describe('isModulePackage', () => {
  it.each([
    [{ type: 'module' }, true],
    [{ type: 'commonjs' }, false],
    [{}, false],
  ])('%j is a module package: %s', async (pkg, expected) => {
    expect(await isModulePackage(await packageRoot(pkg))).toBe(expected);
  });
});

describe('namesFile', () => {
  it.each([
    [
      {
        exports: {
          '.': { types: './dist/types.d.mts', import: './dist/module.mjs' },
        },
      },
      true,
    ],
    [{ types: 'dist/types.d.mts' }, true],
    [{ typesVersions: { '*': { '.': ['./dist/types.d.mts'] } } }, true],
    [{ exports: { '.': { types: './dist/index.d.mts' } } }, false],
    [{}, false],
  ])('%j names dist/types.d.mts: %s', async (pkg, expected) => {
    const root = await packageRoot(pkg);
    expect(await namesFile(root, nodePath.join(root, 'dist/types.d.mts'))).toBe(
      expected,
    );
  });
});
