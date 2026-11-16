import path from 'node:path';
import type TypeScript from 'typescript';

import { LIB_TSCONFIG, PROJECT_TSCONFIG } from './defaults.js';
import { exists } from './exists.js';

/** The TypeScript compiler module (the package's own, see `packageTypeScript`). */
export type TS = typeof TypeScript;

/**
 * `tsconfig` as `tsc -p` reads it: its whole `extends` chain applied, `overrides` on top. A
 * tsconfig that cannot be read fails; option diagnostics are left in `errors` for the caller (a
 * type check reports them, a transpile does not need to).
 */
export function parsedTsconfig(
  ts: TS,
  tsconfig: string,
  overrides: TypeScript.CompilerOptions = {},
): TypeScript.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, overrides, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        `cannot read ${tsconfig}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    },
  });
  if (!parsed) throw new Error(`cannot read ${tsconfig}`);
  return parsed;
}

/**
 * The `paths` of parsed compiler `options`, made absolute: against `baseUrl`, else the tsconfig
 * that declares them (TypeScript's own reading, inherited ones included), else `tsconfig`'s
 * directory. Compiler options handed to a declaration step replace `paths` wholesale, so an
 * override that adds paths carries these over.
 */
export function absolutePaths(
  options: TypeScript.CompilerOptions,
  tsconfig: string,
): Record<string, string[]> {
  const base =
    // eslint-disable-next-line sonarjs/deprecation, @typescript-eslint/no-deprecated -- user tsconfigs may still set baseUrl and it must keep resolving paths
    options.baseUrl ??
    (options.pathsBasePath as string | undefined) ??
    path.dirname(tsconfig);
  return Object.fromEntries(
    Object.entries(options.paths ?? {}).map(([key, targets]) => [
      key,
      targets.map((target) => path.resolve(base, target)),
    ]),
  );
}

/**
 * The tsconfig a module compiles with, as an absolute path: `tsconfig` (relative to `root`) when
 * named, else `tsconfig.lib.json`, else `tsconfig.json` in `root`, else the nearest
 * `tsconfig.json` above it (a package in a monorepo that has none of its own is typed by the
 * workspace's), else `undefined`.
 */
export async function packageTsconfig(
  root: string,
  tsconfig?: string,
): Promise<string | undefined> {
  if (tsconfig) return path.resolve(root, tsconfig);
  const candidates = [LIB_TSCONFIG, PROJECT_TSCONFIG].map((name) =>
    path.resolve(root, name),
  );
  const present = await Promise.all(
    candidates.map(async (file) => exists(file)),
  );
  const own = candidates.find((_, index) => present[index]);
  if (own) return own;
  const ancestors: string[] = [];
  for (
    let dir = path.dirname(path.resolve(root));
    dir !== path.dirname(dir);
    dir = path.dirname(dir)
  )
    ancestors.push(path.join(dir, PROJECT_TSCONFIG));
  const found = await Promise.all(ancestors.map(async (file) => exists(file)));
  return ancestors.find((_, index) => found[index]);
}
