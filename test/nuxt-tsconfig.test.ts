import nodePath from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from '@jest/globals';

import { fixture } from './utils/fixture.js';
import {
  effectiveTsconfig,
  missingTsconfigFile,
  optionalTsconfig,
} from '../src/nuxt-tsconfig.js';

/** A module root holding `files`, with TypeScript installed. */
const tree = async (files: Record<string, string>): Promise<string> =>
  await fixture(files, { link: ['typescript'] });

describe('missingTsconfigFile', () => {
  it('accepts a config whose relative extends exist', async () => {
    const root = await tree({
      'tsconfig.json': '{ "extends": "./base" }',
      'base.json': '{}',
    });
    expect(
      missingTsconfigFile(ts, nodePath.join(root, 'tsconfig.json')),
    ).toBeUndefined();
  });

  it('names the file `nuxt prepare` has not written yet', async () => {
    const root = await tree({
      'tsconfig.json': '{ "extends": "./.nuxt/tsconfig.json" }',
    });
    expect(missingTsconfigFile(ts, nodePath.join(root, 'tsconfig.json'))).toBe(
      nodePath.join(root, '.nuxt/tsconfig.json'),
    );
  });

  it('reads the generated tsconfig of a prepared module, whose paths hold `/*`', async () => {
    const root = await tree({
      'tsconfig.json': '{\n  // Nuxt\n  "extends": "./.nuxt/tsconfig.json"\n}',
      '.nuxt/tsconfig.json':
        '{ "compilerOptions": { "paths": { "~/*": ["../*"] } }, /* generated */ "include": ["../src"] }',
    });
    expect(
      missingTsconfigFile(ts, nodePath.join(root, 'tsconfig.json')),
    ).toBeUndefined();
  });

  it('reads a tsconfig that starts with a byte-order mark, as TypeScript does', async () => {
    const root = await tree({
      'tsconfig.json': '\uFEFF{ "extends": "./base" }',
      'base.json': '{}',
    });
    expect(
      missingTsconfigFile(ts, nodePath.join(root, 'tsconfig.json')),
    ).toBeUndefined();
  });

  it('names a file that cannot be read as a tsconfig', async () => {
    const root = await tree({ 'tsconfig.json': '{ "extends": ' });
    expect(() =>
      missingTsconfigFile(ts, nodePath.join(root, 'tsconfig.json')),
    ).toThrow(/cannot read/);
  });
});

describe('effectiveTsconfig', () => {
  it('uses a config whose chain is complete as it is', async () => {
    const root = await tree({ 'tsconfig.json': '{}', 'package.json': '{}' });
    expect(effectiveTsconfig(root, undefined)).toBe(
      nodePath.join(root, 'tsconfig.json'),
    );
  });

  it('follows a tsconfig whose paths hold comment-like strings and trailing commas', async () => {
    const root = await tree({
      'tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] }, }, "include": ["src/**/*.ts"], }',
      'package.json': '{}',
    });
    expect(effectiveTsconfig(root, undefined)).toBe(
      nodePath.join(root, 'tsconfig.json'),
    );
  });

  it('fails on a chain `nuxt prepare` would complete, saying to run it', async () => {
    const root = await tree({
      'tsconfig.json': '{ "extends": "./.nuxt/tsconfig.json" }',
      'package.json': '{}',
    });
    expect(() => effectiveTsconfig(root, undefined)).toThrow(/nuxi prepare/);
  });

  it('fails on any other broken chain instead of guessing options', async () => {
    const root = await tree({
      'tsconfig.json': '{ "extends": "./base.json" }',
      'package.json': '{}',
    });
    expect(() => effectiveTsconfig(root, undefined)).toThrow(
      /base\.json, which does not exist/,
    );
  });
});

describe('optionalTsconfig', () => {
  it('needs no tsconfig for a module that writes no declarations', async () => {
    const root = await tree({ 'package.json': '{}' });
    expect(
      optionalTsconfig(nodePath.join(root, 'x'), 'tsconfig.build.json', false),
    ).toBeUndefined();
  });

  it('fails without a tsconfig when one is required', async () => {
    const root = await tree({ 'package.json': '{}' });
    expect(() => optionalTsconfig(root, 'tsconfig.build.json', true)).toThrow(
      /tsconfig\.build\.json, which does not exist/,
    );
  });
});
