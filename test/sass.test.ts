import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { compileSass, packageSass } from '../src/sass.js';

/** A package root with a fake Sass installed: `compile` reports the options it was called with. */
function withSass(name: string, source: string): string {
  // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
  const root = mkdtempSync(path.join(tmpdir(), 'nuxt-module-sass-'));
  const dir = path.join(root, 'node_modules', name);
  // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: './index.js' }),
  );
  // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
  writeFileSync(path.join(dir, 'index.js'), source);
  return root;
}

const REPORTING = `export const compile = (file, o) => ({ css: file + " " + o.style + " " + o.loadPaths });
export const compileString = () => ({ css: "" });`;

describe('packageSass', () => {
  it("uses the module's own sass", async () => {
    const root = withSass('sass', REPORTING);
    const sass = await packageSass(root);
    expect(sass.compile('a.scss', {}).css).toContain('a.scss');
  });

  it('falls back to sass-embedded, and reads a default-exported API', async () => {
    const root = withSass(
      'sass-embedded',
      `export default { compile: () => ({ css: "embedded" }), compileString: () => ({ css: "" }) };`,
    );
    const sass = await packageSass(root);
    expect(sass.compile('a.scss', {}).css).toBe('embedded');
  });

  it('fails naming both compilers when neither is installed', async () => {
    // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
    const root = mkdtempSync(path.join(tmpdir(), 'nuxt-module-sass-'));
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
      const root = withSass('sass', REPORTING);
      expect(await compileSass(root, 'theme.scss', minify)).toBe(
        `theme.scss ${style} ${path.join(root, 'node_modules')}`,
      );
    },
  );
});
