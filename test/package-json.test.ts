import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  isModulePackage,
  namesFile,
  readPackageJson,
} from '../src/package-json.js';

function packageRoot(pkg: Record<string, unknown>): string {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const root = mkdtempSync(nodePath.join(tmpdir(), 'vite-package-json-'));
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

describe('readPackageJson', () => {
  it("reads the package's manifest", () => {
    expect(readPackageJson(packageRoot({ name: 'x' })).name).toBe('x');
  });
});

describe('isModulePackage', () => {
  it.each([
    [{ type: 'module' }, true],
    [{ type: 'commonjs' }, false],
    [{}, false],
  ])('%j is a module package: %s', (pkg, expected) => {
    expect(isModulePackage(packageRoot(pkg))).toBe(expected);
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
  ])('%j names dist/types.d.mts: %s', (pkg, expected) => {
    const root = packageRoot(pkg);
    expect(namesFile(root, nodePath.join(root, 'dist/types.d.mts'))).toBe(
      expected,
    );
  });
});
