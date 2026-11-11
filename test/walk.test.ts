import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { walk } from '../src/walk.js';

describe('walk', () => {
  it('lists every file below the directory, relative and sorted, without node_modules', () => {
    // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
    const dir = mkdtempSync(path.join(tmpdir(), 'vite-walk-'));
    for (const file of [
      'b.ts',
      'a/c.vue',
      'a/b/d.ts',
      'node_modules/x/index.js',
    ]) {
      // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
      mkdirSync(path.join(dir, file, '..'), { recursive: true });
      // eslint-disable-next-line n/no-sync -- test setup: sync fs keeps the fixture files inline in the test
      writeFileSync(path.join(dir, file), '');
    }
    expect(walk(dir)).toEqual(['a/b/d.ts', 'a/c.vue', 'b.ts']);
  });
});
