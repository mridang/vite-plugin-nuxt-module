import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { fixture } from './utils/fixture.js';
import { packageTypeScript } from '../src/resolve.js';
import {
  absolutePaths,
  packageTsconfig,
  parsedTsconfig,
} from '../src/tsconfig.js';

const { join } = nodePath;

describe('parsedTsconfig', () => {
  it('applies the extends chain, with overrides on top', async () => {
    const root = await fixture({
      'package.json': '{}',
      'base.json': JSON.stringify({
        compilerOptions: { strict: true, jsx: 'preserve' },
      }),
      'tsconfig.json': JSON.stringify({
        extends: './base.json',
        compilerOptions: {},
      }),
    });
    const ts = await packageTypeScript(root);
    const { options } = parsedTsconfig(ts, join(root, 'tsconfig.json'), {
      noEmit: true,
    });
    expect([options.strict, options.jsx, options.noEmit]).toEqual([
      true,
      ts.JsxEmit.Preserve,
      true,
    ]);
  });

  it('fails on a tsconfig it cannot read, naming it', async () => {
    const root = await fixture({ 'package.json': '{}' });
    const tsconfig = join(root, 'missing.json');
    const ts = await packageTypeScript(root);
    expect(() => parsedTsconfig(ts, tsconfig)).toThrow(
      `cannot read ${tsconfig}`,
    );
  });
});

describe('absolutePaths', () => {
  it('resolves inherited paths against the tsconfig that declares them, and own ones against baseUrl', async () => {
    const root = await fixture({
      'package.json': '{}',
      'config/base.json': JSON.stringify({
        compilerOptions: { paths: { 'a/*': ['../a/*'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: './config/base.json' }),
      'tsconfig.own.json': JSON.stringify({
        compilerOptions: { baseUrl: './lib', paths: { 'b/*': ['b/*'] } },
      }),
    });
    const ts = await packageTypeScript(root);
    const paths = (name: string) =>
      absolutePaths(
        parsedTsconfig(ts, join(root, name)).options,
        join(root, name),
      );
    expect([paths('tsconfig.json'), paths('tsconfig.own.json')]).toEqual([
      { 'a/*': [join(root, 'a/*')] },
      { 'b/*': [join(root, 'lib/b/*')] },
    ]);
  });

  it('is empty without paths', () => {
    expect(absolutePaths({}, '/pkg/tsconfig.json')).toEqual({});
  });
});

describe('packageTsconfig', () => {
  const tree = async (files: Record<string, string>): Promise<string> => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), 'nuxt-module-tsconfig-')),
    );
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, '..'), { recursive: true });
      await writeFile(join(dir, name), text);
    }
    return dir;
  };

  it('prefers tsconfig.lib.json, then tsconfig.json', async () => {
    const withLib = await tree({
      'tsconfig.json': '{}',
      'tsconfig.lib.json': '{}',
    });
    const without = await tree({ 'tsconfig.json': '{}' });
    expect([
      await packageTsconfig(withLib),
      await packageTsconfig(without),
    ]).toEqual([
      join(withLib, 'tsconfig.lib.json'),
      join(without, 'tsconfig.json'),
    ]);
  });

  it('falls back to the nearest tsconfig.json above a monorepo package', async () => {
    const root = await tree({
      'tsconfig.json': '{}',
      'packages/x/package.json': '{}',
    });
    expect(await packageTsconfig(join(root, 'packages/x'))).toBe(
      join(root, 'tsconfig.json'),
    );
  });

  it('takes a named tsconfig as it is, without looking further', async () => {
    const root = await tree({ 'tsconfig.json': '{}' });
    expect(await packageTsconfig(root, 'tsconfig.build.json')).toBe(
      join(root, 'tsconfig.build.json'),
    );
  });
});
