import { readdirSync } from 'node:fs';
import path from 'node:path';

const { join, relative, sep } = path;

/** Orders strings by their bytes, which matches the default sort for file names. */
function byCodeUnit(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Every file under `dir`, relative to it with forward slashes, sorted; `node_modules` is skipped. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    // eslint-disable-next-line n/no-sync -- walk is synchronous: its callers and tests rely on a sync return value
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  visit(dir);
  return out.toSorted(byCodeUnit);
}
