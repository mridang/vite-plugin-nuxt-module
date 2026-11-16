import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Orders strings by their bytes, which matches the default sort for file names. */
function byCodeUnit(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Every file under `dir`, relative to it with forward slashes, sorted; `node_modules` is skipped. */
export async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name !== 'node_modules')
        .map(async (entry) => {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await visit(full);
          else out.push(path.relative(dir, full).split(path.sep).join('/'));
        }),
    );
  };
  await visit(dir);
  return out.toSorted(byCodeUnit);
}
