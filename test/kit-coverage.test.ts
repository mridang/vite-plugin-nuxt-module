import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { FIXTURES } from './contract/paths.js';
import { KIT_API } from './contract/kit-api.js';

/** The names the fixture module imports from `@nuxt/kit`. */
async function importedFromKit(): Promise<string[]> {
  const source = await readFile(
    nodePath.join(FIXTURES, 'module/src/module.ts'),
    'utf8',
  );
  const names =
    /import\s*\{([^}]*)\}\s*from\s*["']@nuxt\/kit["']/.exec(source)?.[1] ?? '';
  return names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
}

describe('the @nuxt/kit API the contract covers', () => {
  it('decides every export of the installed @nuxt/kit', async () => {
    const kit = await import('@nuxt/kit');
    expect(Object.keys(KIT_API).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(kit).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it('covers exactly the exports the fixture module imports', async () => {
    const covered = Object.entries(KIT_API)
      .filter(([, coverage]) => coverage === 'covered')
      .map(([name]) => name)
      .toSorted((a, b) => a.localeCompare(b));
    expect(await importedFromKit()).toEqual(covered);
  });

  it.each(
    Object.entries(KIT_API).filter(([, coverage]) => coverage !== 'covered'),
  )('excludes %s with a reason', (_name, coverage) => {
    expect(coverage).toEqual({ excluded: expect.stringMatching(/\S{3,}/) });
  });
});
