import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import {
  dependencyChain,
  sfcSnippetLoader,
  vueTransformer,
} from '../src/vue-sfc.js';

const { dirname, join } = nodePath;

const dirs: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'nuxt-plugin-test-')),
  );
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A fake `vue-sfc-transformer` at `dir` whose loader names where it was installed. */
function transformer(dir: string, name: string): Record<string, string> {
  return {
    [`${dir}/package.json`]: JSON.stringify({
      name: 'vue-sfc-transformer',
      type: 'module',
      exports: { './mkdist': './mkdist.mjs' },
    }),
    [`${dir}/mkdist.mjs`]: `export const vueLoader = ${JSON.stringify(name)};`,
  };
}

/** A fake Sass that reports the options it compiled with. */
const fakeSass = {
  'node_modules/sass/package.json': JSON.stringify({
    name: 'sass',
    type: 'module',
    exports: { '.': './index.mjs' },
  }),
  'node_modules/sass/index.mjs':
    "export const compile = () => ({ css: '' });\nexport const compileString = (source, o) => ({ css: `/* ${o.syntax} ${o.url} */ ${source}` });\n",
};

describe('dependencyChain', () => {
  it("follows each package from the previous one's install directory", async () => {
    const root = await tree({
      'package.json': '{}',
      'node_modules/builder/package.json': '{}',
      'node_modules/builder/node_modules/inner/package.json': '{}',
    });
    expect(await dependencyChain(root, ['builder', 'inner'])).toEqual([
      root,
      join(root, 'node_modules/builder'),
      join(root, 'node_modules/builder/node_modules/inner'),
    ]);
  });

  it('finds a later package the module installs itself when an earlier one is missing', async () => {
    const root = await tree({
      'package.json': '{}',
      'node_modules/inner/package.json': '{}',
    });
    expect(await dependencyChain(root, ['missing', 'inner'])).toEqual([
      root,
      join(root, 'node_modules/inner'),
    ]);
  });
});

describe('vueTransformer', () => {
  it('fails naming vue-sfc-transformer when the module does not install it', async () => {
    const root = await tree({ 'package.json': '{}' });
    await expect(vueTransformer(root)).rejects.toThrow(
      /install vue-sfc-transformer/,
    );
  });

  it("prefers the module's own vue-sfc-transformer over the builder's", async () => {
    const root = await tree({
      'package.json': '{}',
      ...transformer('node_modules/vue-sfc-transformer', 'own'),
      'node_modules/@nuxt/module-builder/package.json': '{}',
      ...transformer(
        'node_modules/@nuxt/module-builder/node_modules/vue-sfc-transformer',
        'mb',
      ),
    });
    const loaded = await vueTransformer(root);
    expect(loaded.vueLoader).toBe('own');
  });

  it('falls back to the copy nuxt-module-build reaches through its own dependencies', async () => {
    const root = await tree({
      'package.json': '{}',
      'node_modules/@nuxt/module-builder/package.json': '{}',
      'node_modules/@nuxt/module-builder/node_modules/unbuild/package.json':
        '{}',
      'node_modules/@nuxt/module-builder/node_modules/unbuild/node_modules/mkdist/package.json':
        '{}',
      ...transformer(
        'node_modules/@nuxt/module-builder/node_modules/unbuild/node_modules/mkdist/node_modules/vue-sfc-transformer',
        'mkdist',
      ),
    });
    const loaded = await vueTransformer(root);
    expect(loaded.vueLoader).toBe('mkdist');
  });
});

describe('sfcSnippetLoader', () => {
  it('strips TypeScript from a template expression snippet', async () => {
    const [out] = await sfcSnippetLoader(await tree({ 'package.json': '{}' }))({
      extension: '.ts',
      getContents: () =>
        "($attrs['data-slot'] as string | undefined) ?? 'root'",
    });
    expect(out?.contents).not.toContain(' as string');
  });

  it('returns JS the template loader accepts', async () => {
    const [out] = await sfcSnippetLoader(await tree({ 'package.json': '{}' }))({
      extension: '.ts',
      getContents: () => 'x!',
    });
    expect(out?.extension).toBe('.mjs');
  });

  it("compiles a Sass style block to CSS with the module's own Sass", async () => {
    const root = await tree({ 'package.json': '{}', ...fakeSass });
    const [out] = await sfcSnippetLoader(root)({
      extension: '.scss',
      srcPath: join(root, 'src/runtime/C.vue.scss'),
      getContents: () => 'a { b: c }',
    });
    const scssUrl = new URL(`file://${join(root, 'src/runtime/C.vue.scss')}`)
      .href;
    expect(out).toEqual({
      contents: `/* scss ${scssUrl} */ a { b: c }`,
      extension: '.css',
    });
  });

  it('compiles an indented-syntax style block as such', async () => {
    const root = await tree({ 'package.json': '{}', ...fakeSass });
    const [out] = await sfcSnippetLoader(root)({
      extension: '.sass',
      getContents: () => 'a\n  b: c',
    });
    expect(out?.contents).toMatch(/^\/\* indented /);
  });

  it('leaves plain CSS style blocks to the consuming app', async () => {
    const root = await tree({ 'package.json': '{}' });
    expect(
      await sfcSnippetLoader(root)({
        extension: '.css',
        getContents: () => 'a{}',
      }),
    ).toEqual([]);
  });
});
