import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  declaredDependencies,
  escapeRegExp,
  moduleExternals,
  matchesAny,
  packageMatcher,
} from '../src/externals.js';

function packageRoot(pkg: Record<string, unknown>): string {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const root = mkdtempSync(nodePath.join(tmpdir(), 'vite-externals-'));
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

describe('declaredDependencies', () => {
  it('lists dependencies, peerDependencies and optionalDependencies but not devDependencies', () => {
    const root = packageRoot({
      dependencies: { a: '1' },
      peerDependencies: { b: '1' },
      optionalDependencies: { c: '1' },
      devDependencies: { d: '1' },
    });
    expect(declaredDependencies(root)).toEqual(['a', 'b', 'c']);
  });
});

describe('escapeRegExp', () => {
  it('matches the text literally', () => {
    expect(
      new RegExp(`^${escapeRegExp('@scope/a.b+c')}$`).test('@scope/a.b+c'),
    ).toBe(true);
  });
});

describe('packageMatcher', () => {
  it.each([
    ['lit', true],
    ['lit/decorators.js', true],
    ['lit-html', false],
  ])('matches %s: %s', (id, expected) => {
    expect(packageMatcher('lit').test(id)).toBe(expected);
  });
});

describe('matchesAny', () => {
  it('compares strings exactly and tests patterns', () => {
    expect([
      matchesAny('a', ['a']),
      matchesAny('ab', ['a']),
      matchesAny('ab', [/^a/]),
    ]).toEqual([true, false, true]);
  });
});

describe('moduleExternals', () => {
  const root = packageRoot({
    name: 'self-pkg',
    dependencies: { lit: '1', dompurify: '1' },
  });

  it('lists the declared dependencies, the package itself, the extra matchers, then the builtins', () => {
    const list = moduleExternals(root, { external: ['extra'] });
    expect([
      String(list[0]),
      String(list[1]),
      String(list[2]),
      list[3],
      String(list[4]),
    ]).toEqual([
      String.raw`/^lit(\/|$)/`,
      String.raw`/^dompurify(\/|$)/`,
      String.raw`/^self-pkg(\/|$)/`,
      'extra',
      '/^node:/',
    ]);
  });

  it('leaves out a declared dependency listed in bundle', () => {
    expect(
      matchesAny('lit', moduleExternals(root, { bundle: [/^lit$/] })),
    ).toBe(false);
  });

  it("keeps a self-import external so it never inlines a previous build's output", () => {
    expect(matchesAny('self-pkg/plain', moduleExternals(root))).toBe(true);
  });

  it('inlines a self-import listed in bundle', () => {
    expect(
      matchesAny('self-pkg/plain', moduleExternals(root, { bundle: [/.*/] })),
    ).toBe(false);
  });

  it('keeps the unprefixed builtins external', () => {
    expect(matchesAny('fs/promises', moduleExternals(root))).toBe(true);
  });

  it('keeps builtins external whatever bundle says', () => {
    expect(
      matchesAny('events', moduleExternals(root, { bundle: [/.*/] })),
    ).toBe(true);
  });
});
