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

import { buildFixture } from './utils/fixture.js';
import { IMPLICIT_DEPENDENCY } from '../src/defaults.js';
import { nodeModulesPackage } from '../src/implicit-dependencies.js';
import type { NuxtModuleOptions } from '../src/options.js';

const dirs: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(
    await mkdtemp(nodePath.join(tmpdir(), 'nuxt-implicit-test-')),
  );
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(nodePath.dirname(nodePath.join(root, path)), {
      recursive: true,
    });
    await writeFile(nodePath.join(root, path), content);
  }
  return root;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A module importing `helper`, a package it lists only under `devDependencies`. */
const moduleWithDevDependency = {
  'package.json': JSON.stringify({
    name: 'mod',
    type: 'module',
    devDependencies: { helper: '*' },
  }),
  'tsconfig.json': '{}',
  'src/module.ts':
    'import { help } from "helper";\nconst module = () => help();\nexport default module;\n',
  'node_modules/helper/package.json': JSON.stringify({
    name: 'helper',
    type: 'module',
    exports: { '.': './index.js' },
  }),
  'node_modules/helper/index.js': 'export const help = () => 1;\n',
};

async function buildModule(root: string, options: NuxtModuleOptions = {}) {
  await buildFixture(root, { runtimeDir: false, dts: false, ...options });
}

describe('nodeModulesPackage', () => {
  it.each([
    ['/w/node_modules/lit/index.js', 'lit'],
    [
      '/w/node_modules/.pnpm/a@1/node_modules/@scope/pkg/dist/x.js?v=1',
      '@scope/pkg',
    ],
    ['/w/src/module.ts', undefined],
  ])('names the package of %s', (id, expected) => {
    expect(nodeModulesPackage(id)).toBe(expected);
  });
});

describe('implicitDependencies', () => {
  it('fails a build that inlines a package the module does not depend on', async () => {
    await expect(
      buildModule(await tree(moduleWithDevDependency)),
    ).rejects.toThrow(/Implicitly bundling "helper"/);
  }, 60_000);

  it('inlines it anyway when its warning code is allowed', async () => {
    const root = await tree(moduleWithDevDependency);
    await buildModule(root, { allowWarnings: [IMPLICIT_DEPENDENCY] });
    expect(
      await readFile(nodePath.join(root, 'dist/module.mjs'), 'utf8'),
    ).toContain('const help = ');
  }, 60_000);

  it('inlines a package listed in bundle', async () => {
    const root = await tree(moduleWithDevDependency);
    await buildModule(root, { bundle: ['helper'] });
    expect(
      await readFile(nodePath.join(root, 'dist/module.mjs'), 'utf8'),
    ).toContain('const help = ');
  }, 60_000);
});
