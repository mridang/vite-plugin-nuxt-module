import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { matchesAny } from '../src/externals.js';
import { resolveOptions } from '../src/options.js';

const DEFAULT_FILES: Record<string, string> = { 'src/module.ts': '' };
const DEFAULT_PACKAGE: Record<string, unknown> = {
  name: 'mod',
  type: 'module',
};

/** A module package: `src/module.ts` and an empty `src/runtime` unless `files` says otherwise. */
async function packageRoot(
  files: Record<string, string> = DEFAULT_FILES,
  pkg: Record<string, unknown> = DEFAULT_PACKAGE,
): Promise<string> {
  const root = await realpath(
    await mkdtemp(nodePath.join(tmpdir(), 'nuxt-module-options-')),
  );
  const all = {
    'package.json': JSON.stringify(pkg),
    'tsconfig.json': '{}',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(nodePath.dirname(nodePath.join(root, path)), {
      recursive: true,
    });
    await writeFile(nodePath.join(root, path), content);
  }
  if ('src/module.ts' in files)
    await mkdir(nodePath.join(root, 'src/runtime'), { recursive: true });
  return root;
}

describe('resolveOptions', () => {
  it('builds the module and its per-file runtime by default', async () => {
    const root = await packageRoot();
    const o = await resolveOptions({}, root);
    expect([o.entry, o.runtimeDir, o.extension, o.dts, o.sourcemap]).toEqual([
      { module: nodePath.join(root, 'src/module.ts') },
      nodePath.join(root, 'src/runtime'),
      '.mjs',
      true,
      false,
    ]);
  });

  it('bundles extra entries next to the module', async () => {
    const root = await packageRoot();
    const awaited1 = await resolveOptions(
      { entry: { server: 'src/server.ts' } },
      root,
    );
    expect(awaited1.entry).toEqual({
      module: nodePath.join(root, 'src/module.ts'),
      server: nodePath.join(root, 'src/server.ts'),
    });
  });

  it('names listed entries after their files', async () => {
    const root = await packageRoot();
    const awaited2 = await resolveOptions(
      { entry: ['src/utils/headers.ts'] },
      root,
    );
    expect(awaited2.entry).toEqual({
      module: nodePath.join(root, 'src/module.ts'),
      headers: nodePath.join(root, 'src/utils/headers.ts'),
    });
  });

  it('builds a module file that is not src/module.ts', async () => {
    const root = await packageRoot({ 'src/nuxt.ts': '' });
    const awaited3 = await resolveOptions({ module: 'src/nuxt.ts' }, root);
    expect(awaited3.entry).toEqual({
      module: nodePath.join(root, 'src/nuxt.ts'),
    });
  });

  it('fails without a module file to build', async () => {
    const root = await packageRoot({});
    await expect(resolveOptions({}, root)).rejects.toThrow(
      /no module to build: src\/module\.ts does not exist/,
    );
  });

  it('refuses an entry inside the runtime directory, which is built file by file', async () => {
    const root = await packageRoot();
    await expect(
      resolveOptions(
        { entry: { 'runtime/plugin': 'src/runtime/plugin.ts' } },
        root,
      ),
    ).rejects.toThrow(/src\/runtime\/plugin\.ts lie in the runtime directory/);
  });

  it.each([['.cjs'], ['.jsx']])(
    'refuses the extension %s, which Node cannot import as ESM',
    async (ext) => {
      const root = await packageRoot();
      await expect(
        resolveOptions({ extension: ext as '.mjs' }, root),
      ).rejects.toThrow(`extension ${ext} is not one of .mjs, .js`);
    },
  );

  it('refuses the extension .js in a package that is not an ES module package', async () => {
    const root = await packageRoot(undefined, {
      name: 'mod',
      type: 'commonjs',
    });
    await expect(resolveOptions({ extension: '.js' }, root)).rejects.toThrow(
      /"type": "module"/,
    );
  });

  it('accepts the extension .js in an ES module package', async () => {
    const awaited4 = await resolveOptions(
      { extension: '.js' },
      await packageRoot(),
    );
    expect(awaited4.extension).toBe('.js');
  });

  it('refuses a runtime directory that does not exist', async () => {
    const root = await packageRoot();
    await expect(
      resolveOptions({ runtimeDir: 'src/missing' }, root),
    ).rejects.toThrow(/runtime directory src\/missing not found/);
  });

  it('has no runtime for a module without one', async () => {
    const awaited5 = await resolveOptions(
      { runtimeDir: false },
      await packageRoot(),
    );
    expect(awaited5.runtimeDir).toBeUndefined();
  });

  it('has no runtime when the default directory does not exist', async () => {
    const root = await packageRoot();
    await rm(nodePath.join(root, 'src/runtime'), { recursive: true });
    const awaited6 = await resolveOptions({}, root);
    expect(awaited6.runtimeDir).toBeUndefined();
  });

  it('writes no source maps unless asked, like @nuxt/module-builder', async () => {
    const awaited7 = await resolveOptions({}, await packageRoot());
    expect(awaited7.sourcemap).toBe(false);
  });

  it.each([
    [{ sourcemap: true }, {}, true],
    [{}, { build: { sourcemap: true } }, true],
    [{ sourcemap: false }, { build: { sourcemap: true } }, false],
  ])(
    'decides source maps for %j under the Vite config %j: %s',
    async (options, vite, expected) => {
      const awaited8 = await resolveOptions(options, await packageRoot(), vite);
      expect(awaited8.sourcemap).toBe(expected);
    },
  );

  it.each([
    ['#app'],
    ['nuxt/kit'],
    ['@nuxt/kit'],
    ['h3'],
    ['vue'],
    ['node:fs'],
  ])('leaves %s to the app', async (id) => {
    const awaited9 = await resolveOptions({}, await packageRoot());
    expect(matchesAny(id, awaited9.external)).toBe(true);
  });

  it('leaves a declared dependency and an extra external alone, and inlines the rest', async () => {
    const root = await packageRoot(
      { 'src/module.ts': '' },
      { name: 'mod', type: 'module', dependencies: { dep: '1' } },
    );
    const { external } = await resolveOptions({ external: ['extra'] }, root);
    expect([
      matchesAny('dep', external),
      matchesAny('extra', external),
      matchesAny('other', external),
    ]).toEqual([true, true, false]);
  });

  it('reads dts options', async () => {
    const o = await resolveOptions(
      { dts: { compatible: true, eager: true } },
      await packageRoot(),
    );
    expect([o.dts, o.compatible, o.eager]).toEqual([true, true, true]);
  });

  it('turns declarations off', async () => {
    const o = await resolveOptions({ dts: false }, await packageRoot());
    expect([o.dts, o.compatible, o.eager]).toEqual([false, false, false]);
  });
});
