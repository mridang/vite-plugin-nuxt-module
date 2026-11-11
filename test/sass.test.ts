import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { compileSass, packageSass } from '../src/sass.js';

/** A package root with a fake Sass installed: `compile` reports the options it was called with. */
async function withSass(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'nuxt-module-sass-'));
  const dir = path.join(root, 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: './index.js' }),
  );
  await writeFile(path.join(dir, 'index.js'), source);
  return root;
}

const REPORTING = `export const compile = (file, o) => ({ css: file + " " + o.style + " " + o.loadPaths });
export const compileString = () => ({ css: "" });`;

describe('packageSass', () => {
  it("uses the module's own sass", async () => {
    const root = await withSass('sass', REPORTING);
    const sass = await packageSass(root);
    expect(sass.compile('a.scss', {}).css).toContain('a.scss');
  });

  it('falls back to sass-embedded, and reads a default-exported API', async () => {
    const root = await withSass(
      'sass-embedded',
      `export default { compile: () => ({ css: "embedded" }), compileString: () => ({ css: "" }) };`,
    );
    const sass = await packageSass(root);
    expect(sass.compile('a.scss', {}).css).toBe('embedded');
  });

  it('fails naming both compilers when neither is installed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nuxt-module-sass-'));
    await expect(packageSass(root)).rejects.toThrow(
      /none of sass, sass-embedded is installed/,
    );
  });
});

describe('compileSass', () => {
  it.each([
    [false, 'expanded'],
    [true, 'compressed'],
  ])(
    "compiles with minify %s as %s, resolving from the module's node_modules",
    async (minify, style) => {
      const root = await withSass('sass', REPORTING);
      expect(await compileSass(root, 'theme.scss', minify)).toBe(
        `theme.scss ${style} ${path.join(root, 'node_modules')}`,
      );
    },
  );
});
