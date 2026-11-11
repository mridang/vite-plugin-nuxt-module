import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { posixPath } from '../entries.js';
import { exists } from '../exists.js';
import { escapeRegExp } from '../externals.js';
import { readPackageJson } from '../package-json.js';
import { packageTypeScript } from '../resolve.js';
import { absolutePaths, parsedTsconfig } from '../tsconfig.js';
import { walk } from '../walk.js';

/** What {@link selfReferenceOptions} adds to the declaration step's options. */
export interface SelfReferenceOptions {
  readonly compilerOptions?: { readonly paths: Record<string, string[]> };
  readonly aliasesExclude?: RegExp[];
}

/** Source extensions a declaration file can be generated from. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** The `types` target of an exports-map entry: a `.d.ts` string, or the first `types` condition found. */
export function typesTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string')
    return /\.d\.[cm]?ts$/.test(entry) ? entry : undefined;
  if (!entry || typeof entry !== 'object') return undefined;
  const conditions = entry as Record<string, unknown>;
  if (typeof conditions.types === 'string') return conditions.types;
  for (const nested of Object.values(conditions)) {
    const found = typesTarget(nested);
    if (found) return found;
  }
  return undefined;
}

/** Whether a source file under `entryRoot` names package `name` (`"name"` or `"name/…"`). */
async function importsItself(
  entryRoot: string,
  name: string,
): Promise<boolean> {
  if (!(await exists(entryRoot))) return false;
  const files = await walk(entryRoot);
  const texts = await Promise.all(
    files.map((file) => readFile(path.join(entryRoot, file), 'utf8')),
  );
  return texts.some(
    (text) =>
      text.includes(`"${name}"`) ||
      text.includes(`"${name}/`) ||
      text.includes(`'${name}`),
  );
}

/**
 * The declaration step pins TypeScript's `outDir` to the package root, so a package importing its
 * own name (`import config from "next-intl/config"`) no longer maps the exports' `types` target back
 * to the source. This maps each self-reference to its source file instead, and keeps the specifier
 * bare in the output: `paths` for every `exports` subpath whose `types` target lies in `dtsOutDir`,
 * pointing at the source file it is generated from (merged over the `paths` the tsconfig compiles
 * with, made absolute): the entry of that name (`entries`, output name to source file), else the
 * file at the same path under `entryRoot`. Empty when no source imports the package's own name.
 */
export async function selfReferenceOptions(
  root: string,
  dtsOutDir: string,
  entryRoot: string,
  tsconfig: string,
  entries: Readonly<Record<string, string>> = {},
): Promise<SelfReferenceOptions> {
  const pkg = await readPackageJson(root);
  if (!pkg.name || !pkg.exports || typeof pkg.exports !== 'object') return {};
  if (!(await importsItself(entryRoot, pkg.name))) return {};
  const map = Object.keys(pkg.exports).some((k) => k.startsWith('.'))
    ? (pkg.exports as Record<string, unknown>)
    : { '.': pkg.exports };
  const found = await Promise.all(
    Object.entries(map).map(async ([sub, target]) => {
      const types = typesTarget(target);
      const rel = types
        ? path.relative(dtsOutDir, path.resolve(root, types))
        : '..';
      if (!types || sub.includes('*') || rel.startsWith('..')) return undefined;
      const name = posixPath(rel.replace(/\.d\.[cm]?ts$/, ''));
      const base = path.resolve(entryRoot, name);
      const candidates = SOURCE_EXTENSIONS.map((e) => base + e);
      const present = await Promise.all(candidates.map((f) => exists(f)));
      const source = entries[name] ?? candidates.find((_, i) => present[i]);
      return source ? ([sub, source] as const) : undefined;
    }),
  );
  const paths: Record<string, string[]> = {};
  for (const entry of found) {
    if (!entry) continue;
    const [sub, source] = entry;
    paths[sub === '.' ? pkg.name : `${pkg.name}${sub.slice(1)}`] = [source];
  }
  if (Object.keys(paths).length === 0) return {};
  // `compilerOptions` replaces the tsconfig's `paths` wholesale: carry those over, made absolute.
  const names = Object.keys(paths).map(
    (n) => new RegExp(`^${escapeRegExp(n)}$`),
  );
  const own = (await exists(tsconfig))
    ? absolutePaths(
        parsedTsconfig(packageTypeScript(root), tsconfig).options,
        tsconfig,
      )
    : {};
  return {
    compilerOptions: { paths: { ...own, ...paths } },
    aliasesExclude: names,
  };
}
