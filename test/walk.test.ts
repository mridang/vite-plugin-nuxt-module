import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { walk } from '../src/walk.js';

describe('walk', () => {
  it('lists every file below the directory, relative and sorted, without node_modules', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vite-walk-'));
    for (const file of [
      'b.ts',
      'a/c.vue',
      'a/b/d.ts',
      'node_modules/x/index.js',
    ]) {
      await mkdir(path.join(dir, file, '..'), { recursive: true });
      await writeFile(path.join(dir, file), '');
    }
    expect(await walk(dir)).toEqual(['a/b/d.ts', 'a/c.vue', 'b.ts']);
  });
});
