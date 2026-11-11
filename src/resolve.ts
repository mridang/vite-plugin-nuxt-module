import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type TypeScript from 'typescript';

import { exists } from './exists.js';

const { dirname, join, resolve } = path;

/** A `require` that resolves like code inside the package at `root`. */
export function requireFrom(root: string): ReturnType<typeof createRequire> {
  return createRequire(resolve(root, 'package.json'));
}

/** The export conditions a tool is loaded through: how Node's ESM loader resolves it. */
const IMPORT_CONDITIONS: readonly string[] = ['import', 'node', 'default'];

/** `specifier` split into its package name and subpath (`@scope/pkg/sub` → `@scope/pkg`, `./sub`). */
export function packageSpecifier(specifier: string): {
  name: string;
  subpath: string;
} {
  const [, name = specifier, sub = ''] =
    /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(specifier) ?? [];
  return { name, subpath: `.${sub}` };
}

/**
 * The target of an exports-map value under `conditions`: a string, the first matching condition in
 * the order the map lists them (nested conditions followed), or the first array item that resolves.
 */
function exportTarget(
  value: unknown,
  conditions: readonly string[] = IMPORT_CONDITIONS,
): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item, conditions);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [condition, nested] of Object.entries(value)) {
    if (!conditions.includes(condition)) continue;
    const target = exportTarget(nested, conditions);
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * The file `subpath` (`.`, `./sub`) of a package's `exports` field names under `conditions`:
 * condition sugar (`{ import: … }` for `.`), subpath maps and `*` patterns (longest prefix first).
 */
export function exportsTarget(
  exportsField: unknown,
  subpath: string,
  conditions: readonly string[] = IMPORT_CONDITIONS,
): string | undefined {
  const isMap =
    !!exportsField &&
    typeof exportsField === 'object' &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'));
  const map = (isMap ? exportsField : { '.': exportsField }) as Record<
    string,
    unknown
  >;
  if (subpath in map) return exportTarget(map[subpath], conditions);
  const patterns = Object.keys(map)
    .filter((key) => key.includes('*'))
    .toSorted((a, b) => b.indexOf('*') - a.indexOf('*'));
  for (const key of patterns) {
    const [prefix = '', suffix = ''] = key.split('*');
    if (
      !subpath.startsWith(prefix) ||
      !subpath.endsWith(suffix) ||
      subpath.length < prefix.length + suffix.length
    )
      continue;
    const match = subpath.slice(prefix.length, subpath.length - suffix.length);
    return exportTarget(map[key], conditions)?.replaceAll('*', match);
  }
  return undefined;
}

/**
 * The installed directory of package `name` as seen from `root`: the nearest `node_modules/<name>`
 * from `root` upwards, the lookup `import` does (no `NODE_PATH`, no global folders, so a package
 * hoisted for another one is never picked up).
 */
export async function packageDirectory(
  name: string,
  root: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', name));
    if (dirname(dir) === dir) break;
  }
  const present = await Promise.all(
    candidates.map((candidate) => exists(join(candidate, 'package.json'))),
  );
  return candidates.find((_, i) => present[i]);
}

/**
 * {@link packageDirectory} as its real path: under pnpm's symlinked layout the package's own
 * dependencies are found only from there (a tool a package brings, looked up through it).
 */
export async function realPackageDirectory(
  name: string,
  root: string,
): Promise<string | undefined> {
  const dir = await packageDirectory(name, root);
  return dir === undefined ? undefined : realpath(dir);
}

/**
 * The file `specifier` loads from the package at `root`, resolved the way `import` does: through
 * the package's `exports` with {@link IMPORT_CONDITIONS} (a package that exports neither its
 * `package.json` nor a `require` condition included), else its `main` and file layout.
 */
async function resolvePackageFile(
  specifier: string,
  root: string,
): Promise<string> {
  const { name, subpath } = packageSpecifier(specifier);
  const dir = await packageDirectory(name, root);
  if (dir === undefined)
    throw new Error(`cannot find package ${name} from ${root}`);
  if (subpath === './package.json') return join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    exports?: unknown;
  };
  if (pkg.exports !== undefined) {
    const target =
      exportsTarget(pkg.exports, subpath) ??
      exportsTarget(pkg.exports, subpath, ['require', 'node', 'default']);
    if (target === undefined)
      throw new Error(`${name} does not export ${subpath} (from ${root})`);
    return resolve(dir, target);
  }
  // No exports map: `main` (or `index.js`) of the directory, or the file a subpath names.
  return requireFrom(root).resolve(subpath === '.' ? dir : join(dir, subpath));
}

/** `specifier` resolved from the package at `root`, or `undefined` when it is not installed there. */
export async function resolveFromRoot(
  specifier: string,
  root: string,
): Promise<string | undefined> {
  try {
    return await resolvePackageFile(specifier, root);
  } catch {
    return undefined;
  }
}

/**
 * Imports a framework tool (a Vite plugin, a compiler) from the package being built rather than
 * from this package, so each package builds with the exact version it declares.
 */
export async function importFromRoot<T = unknown>(
  specifier: string,
  root: string = process.cwd(),
): Promise<T> {
  // eslint-disable-next-line no-unsanitized/method -- the specifier is a tool the package declares
  return (await import(
    pathToFileURL(await resolvePackageFile(specifier, root)).href
  )) as T;
}

/** The TypeScript compiler the package at `root` declares (a CommonJS package, so loaded synchronously). */
export async function packageTypeScript(
  root: string,
): Promise<typeof TypeScript> {
  return requireFrom(root)(
    await resolvePackageFile('typescript', root),
  ) as typeof TypeScript;
}

/**
 * {@link packageTypeScript}, else the TypeScript this package resolves (an optional peer), for
 * work that does not depend on the version, like reading a tsconfig file as text: a package
 * whose build needs no type information need not install TypeScript for it.
 */
export async function anyTypeScript(root: string): Promise<typeof TypeScript> {
  return (await resolveFromRoot('typescript', root)) === undefined
    ? (createRequire(import.meta.url)('typescript') as typeof TypeScript)
    : packageTypeScript(root);
}
