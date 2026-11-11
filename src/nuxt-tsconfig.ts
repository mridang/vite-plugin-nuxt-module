import { stat } from 'node:fs/promises';
import path from 'node:path';

import { NUXT_BUILD_DIR, PROJECT_TSCONFIG } from './defaults.js';
import { exists } from './exists.js';
import { anyTypeScript } from './resolve.js';
import { packageTsconfig, type TS } from './tsconfig.js';

interface TsconfigJson {
  readonly references?: readonly { readonly path: string }[];
  readonly extends?: unknown;
}

const isFile = (p: string): Promise<boolean> =>
  stat(p)
    .then((info) => info.isFile())
    .catch(() => false);

/**
 * The first result of `check` over `items`, in order, running each only when the ones before it found nothing.
 */
const firstFound = <T, R>(
  items: readonly T[],
  check: (item: T) => Promise<R | undefined>,
): Promise<R | undefined> =>
  items.reduce<Promise<R | undefined>>(
    async (previous, item) => (await previous) ?? check(item),
    Promise.resolve(undefined),
  );

/**
 * The first file `file` extends or references by path (recursively) that does not exist, or `undefined` when the
 * chain is complete. A module's tsconfig usually extends `.nuxt/tsconfig.json`, which only `nuxi prepare` writes.
 * Each file is read as TypeScript reads it (comments, trailing commas, a byte-order mark), without applying its
 * chain, which is what is checked; package `extends` (`"@nuxt/tsconfig"`) are left to TypeScript.
 */
export async function missingTsconfigFile(
  ts: TS,
  file: string,
): Promise<string | undefined> {
  if (!(await isFile(file))) return file;
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error)
    throw new Error(
      `cannot read ${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
    );
  const json = (config ?? {}) as TsconfigJson;
  const missingReference = await firstFound(
    json.references ?? [],
    async (ref) => {
      const p = path.resolve(path.dirname(file), ref.path);
      const found = await Promise.all([
        isFile(p),
        isFile(`${p}.json`),
        isFile(path.join(p, PROJECT_TSCONFIG)),
      ]);
      return found.some(Boolean) ? undefined : p;
    },
  );
  if (missingReference) return missingReference;
  const ext = json.extends;
  const extended: unknown[] = Array.isArray(ext) ? ext : [ext];
  return firstFound(extended, async (e) => {
    if (typeof e !== 'string' || !(e.startsWith('.') || path.isAbsolute(e)))
      return undefined;
    const p = path.resolve(path.dirname(file), e);
    const target = (await isFile(p)) || p.endsWith('.json') ? p : `${p}.json`;
    return missingTsconfigFile(ts, target);
  });
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
export async function effectiveTsconfig(
  root: string,
  tsconfig: string | undefined,
): Promise<string> {
  const base = await packageTsconfig(root, tsconfig);
  if (!base)
    throw new Error(`nuxtModule: no tsconfig found in ${root} or above it`);
  const missing = await missingTsconfigFile(anyTypeScript(root), base);
  if (missing) throw new Error(brokenTsconfigMessage(root, base, missing));
  return base;
}

/**
 * {@link effectiveTsconfig}, or `undefined` when the module has no tsconfig at all and needs none (no declarations):
 * the transpiler then finds the nearest one itself.
 */
export async function optionalTsconfig(
  root: string,
  tsconfig: string | undefined,
  required: boolean,
): Promise<string | undefined> {
  const base = await packageTsconfig(root, tsconfig);
  if (!required && (!base || !(await exists(base)))) return undefined;
  return effectiveTsconfig(root, tsconfig);
}
