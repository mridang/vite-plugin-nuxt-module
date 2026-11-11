import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

import {
  declaredDependencies,
  escapeRegExp,
  moduleExternals,
  matchesAny,
  packageMatcher,
} from '../src/externals.js';

async function packageRoot(pkg: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'vite-externals-'));
  await writeFile(nodePath.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

describe('declaredDependencies', () => {
  it('lists dependencies, peerDependencies and optionalDependencies but not devDependencies', async () => {
    const root = await packageRoot({
      dependencies: { a: '1' },
      peerDependencies: { b: '1' },
      optionalDependencies: { c: '1' },
      devDependencies: { d: '1' },
    });
    expect(await declaredDependencies(root)).toEqual(['a', 'b', 'c']);
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
  let root: string;
  beforeAll(async () => {
    root = await packageRoot({
      name: 'self-pkg',
      dependencies: { lit: '1', dompurify: '1' },
    });
  });

  it('lists the declared dependencies, the package itself, the extra matchers, then the builtins', async () => {
    const list = await moduleExternals(root, { external: ['extra'] });
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

  it('leaves out a declared dependency listed in bundle', async () => {
    expect(
      matchesAny('lit', await moduleExternals(root, { bundle: [/^lit$/] })),
    ).toBe(false);
  });

  it("keeps a self-import external so it never inlines a previous build's output", async () => {
    expect(matchesAny('self-pkg/plain', await moduleExternals(root))).toBe(
      true,
    );
  });

  it('inlines a self-import listed in bundle', async () => {
    expect(
      matchesAny(
        'self-pkg/plain',
        await moduleExternals(root, { bundle: [/.*/] }),
      ),
    ).toBe(false);
  });

  it('keeps the unprefixed builtins external', async () => {
    expect(matchesAny('fs/promises', await moduleExternals(root))).toBe(true);
  });

  it('keeps builtins external whatever bundle says', async () => {
    expect(
      matchesAny('events', await moduleExternals(root, { bundle: [/.*/] })),
    ).toBe(true);
  });
});
