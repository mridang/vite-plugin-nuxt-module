import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { posixPath } from '../entries.js';
import { exists } from '../exists.js';
import { escapeRegExp } from '../externals.js';
import { readPackageJson } from '../package-json.js';
import { packageTypeScript } from '../resolve.js';
import { absolutePaths, parsedTsconfig } from '../tsconfig.js';
import { walk } from '../walk.js';
import { isRecord } from '../is-record.js';

const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/u;

/** What {@link selfReferenceOptions} adds to the declaration step's options. */
export interface SelfReferenceOptions {
  readonly compilerOptions?: { readonly paths: Record<string, string[]> };
  readonly aliasesExclude?: RegExp[];
}

/** Source extensions a declaration file can be generated from. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** The `types` target of an exports-map entry: a `.d.ts` string, or the first `types` condition found. */
export function typesTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return DECLARATION_FILE_PATTERN.test(entry) ? entry : undefined;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  if (typeof entry.types === 'string') {
    return entry.types;
  }
  return Object.values(entry)
    .values()
    .map((nested) => typesTarget(nested))
    .find(Boolean);
}

/** Whether a source file under `entryRoot` names package `name` (`"name"` or `"name/…"`). */
async function importsItself(
  entryRoot: string,
  name: string,
): Promise<boolean> {
  if (!(await exists(entryRoot))) {
    return false;
  }
  const files = await walk(entryRoot);
  const texts = await Promise.all(
    files.map(async (file) => readFile(path.join(entryRoot, file), 'utf8')),
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
  const exportsField = pkg.exports;
  if (!pkg.name || !isRecord(exportsField)) {
    return {};
  }
  if (!(await importsItself(entryRoot, pkg.name))) {
    return {};
  }
  const map = Object.keys(exportsField).some((k) => k.startsWith('.'))
    ? exportsField
    : { '.': exportsField };
  const found = await Promise.all(
    Object.entries(map).map(
      async ([sub, target]): Promise<readonly [string, string] | undefined> => {
        const types = typesTarget(target);
        const relativeTypes = types
          ? path.relative(dtsOutDir, path.resolve(root, types))
          : '..';
        if (!types || sub.includes('*') || relativeTypes.startsWith('..')) {
          return undefined;
        }
        const name = posixPath(
          relativeTypes.replace(DECLARATION_FILE_PATTERN, ''),
        );
        const base = path.resolve(entryRoot, name);
        const candidates = SOURCE_EXTENSIONS.map(
          (extension) => base + extension,
        );
        const present = await Promise.all(
          candidates.map(async (f) => exists(f)),
        );
        const source =
          entries[name] ?? candidates.find((_, index) => present[index]);
        return source ? ([sub, source] as const) : undefined;
      },
    ),
  );
  const packageName = pkg.name;
  const paths = Object.fromEntries(
    found.flatMap((entry): [string, string[]][] => {
      if (!entry) {
        return [];
      }
      const [sub, source] = entry;
      return [
        [sub === '.' ? packageName : `${packageName}${sub.slice(1)}`, [source]],
      ];
    }),
  );
  if (Object.keys(paths).length === 0) {
    return {};
  }
  // `compilerOptions` replaces the tsconfig's `paths` wholesale: carry those over, made absolute.
  const names = Object.keys(paths).map(
    (n) => new RegExp(`^${escapeRegExp(n)}$`, 'u'),
  );
  const own = (await exists(tsconfig))
    ? absolutePaths(
        parsedTsconfig(await packageTypeScript(root), tsconfig).options,
        tsconfig,
      )
    : {};
  return {
    compilerOptions: { paths: { ...own, ...paths } },
    aliasesExclude: names,
  };
}
