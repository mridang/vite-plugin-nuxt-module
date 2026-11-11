import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { NUXT_BUILD_DIR, PROJECT_TSCONFIG } from './defaults.js';
import { anyTypeScript } from './resolve.js';
import { packageTsconfig, type TS } from './tsconfig.js';

interface TsconfigJson {
  readonly references?: readonly { readonly path: string }[];
  readonly extends?: unknown;
}

// eslint-disable-next-line n/no-sync -- the tsconfig chain is read synchronously through the TypeScript API, so its file checks stay sync
const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/**
 * The first file `file` extends or references by path (recursively) that does not exist, or `undefined` when the
 * chain is complete. A module's tsconfig usually extends `.nuxt/tsconfig.json`, which only `nuxi prepare` writes.
 * Each file is read as TypeScript reads it (comments, trailing commas, a byte-order mark), without applying its
 * chain, which is what is checked; package `extends` (`"@nuxt/tsconfig"`) are left to TypeScript.
 */
export function missingTsconfigFile(ts: TS, file: string): string | undefined {
  if (!isFile(file)) return file;
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error)
    throw new Error(
      `cannot read ${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
    );
  const json = (config ?? {}) as TsconfigJson;
  for (const ref of json.references ?? []) {
    const p = path.resolve(path.dirname(file), ref.path);
    if (
      !isFile(p) &&
      !isFile(`${p}.json`) &&
      !isFile(path.join(p, PROJECT_TSCONFIG))
    )
      return p;
  }
  const ext = json.extends;
  const extended: unknown[] = Array.isArray(ext) ? ext : [ext];
  for (const e of extended) {
    if (typeof e !== 'string' || !(e.startsWith('.') || path.isAbsolute(e)))
      continue;
    const p = path.resolve(path.dirname(file), e);
    const target = isFile(p) || p.endsWith('.json') ? p : `${p}.json`;
    const missing = missingTsconfigFile(ts, target);
    if (missing) return missing;
  }
  return undefined;
}

/** Why the build cannot type the module with `tsconfig`, whose chain names `missing`, and what fixes it. */
function brokenTsconfigMessage(
  root: string,
  tsconfig: string,
  missing: string,
): string {
  const generated = missing.split(path.sep).includes(NUXT_BUILD_DIR);
  return [
    `nuxtModule: ${path.relative(root, tsconfig) || tsconfig} needs ${path.relative(root, missing) || missing}, which does not exist.`,
    generated
      ? 'It is written by `nuxi prepare`: run that before the build, or set `prepare: true` to have the build run it.'
      : 'Create it, or point `tsconfig` at a tsconfig whose chain is complete.',
  ].join(' ');
}

/**
 * The tsconfig the module is typed and transpiled with. A Nuxt module's tsconfig usually extends
 * `.nuxt/tsconfig.json` (Nuxt's aliases, `#app`, the hoisted `@nuxt/schema`): a build without it would type the module
 * with different options than the editor does, so a broken chain fails with what to run instead of being guessed at.
 */
export function effectiveTsconfig(
  root: string,
  tsconfig: string | undefined,
): string {
  const base = packageTsconfig(root, tsconfig);
  if (!base)
    throw new Error(`nuxtModule: no tsconfig found in ${root} or above it`);
  const missing = missingTsconfigFile(anyTypeScript(root), base);
  if (missing) throw new Error(brokenTsconfigMessage(root, base, missing));
  return base;
}

/**
 * {@link effectiveTsconfig}, or `undefined` when the module has no tsconfig at all and needs none (no declarations):
 * the transpiler then finds the nearest one itself.
 */
export function optionalTsconfig(
  root: string,
  tsconfig: string | undefined,
  required: boolean,
): string | undefined {
  const base = packageTsconfig(root, tsconfig);
  // eslint-disable-next-line n/no-sync -- optionalTsconfig is synchronous and tested as such; async would ripple into its callers
  if (!required && (!base || !existsSync(base))) return undefined;
  return effectiveTsconfig(root, tsconfig);
}
