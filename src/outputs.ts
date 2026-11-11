import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

import { emitBundledTypes } from './declarations/bundle.js';
import { PLUGIN_PREFIX } from './defaults.js';
import { exists, firstFound } from './exists.js';
import type { ResolvedOptions } from './options.js';
import { packageTypeScript, realPackageDirectory } from './resolve.js';
import { absolutePaths, parsedTsconfig } from './tsconfig.js';
import { afterBuild } from './warnings.js';
import { writeModuleJson } from './module-json.js';
import { buildRuntime, declarationRuntimeExternals } from './runtime.js';
import { effectiveTsconfig } from './nuxt-tsconfig.js';
import { writeTypesEntry } from './types-entry.js';

/** Where shared chunks of the bundled module go, per extension (what `nuxt-module-build` writes). */
export const sharedChunkFileNames = (ext: string): string =>
  `shared/[name].[hash]${ext}`;

/**
 * Packages a module's declaration names types from without depending on them: `defineNuxtModule()` returns
 * `@nuxt/schema`'s `NuxtModule`, and a module usually depends on `@nuxt/kit` alone. Nuxt hoists them into the
 * generated tsconfig's `paths`; the declaration step does the same, through the Nuxt packages the module has.
 */
const NUXT_HOISTED_TYPES: readonly string[] = ['@nuxt/schema'];

/** The Nuxt packages a hoisted type package is looked for through, in order. */
const HOISTED_FROM: readonly string[] = ['@nuxt/kit', 'nuxt'];

/** Where a {@link NUXT_HOISTED_TYPES} package is installed: the module's own copy, else its Nuxt packages' copy. */
async function hoistedTypeDir(
  name: string,
  root: string,
): Promise<string | undefined> {
  const own = await realPackageDirectory(name, root);
  if (own) return own;
  return firstFound(HOISTED_FROM, async (via) => {
    const viaDir = await realPackageDirectory(via, root);
    return viaDir ? realPackageDirectory(name, viaDir) : undefined;
  });
}

/**
 * `paths` that let the declaration emitter name the types a module's declaration needs, like the `paths` Nuxt writes
 * into `.nuxt/tsconfig.json` and `nuxt-module-build` adds: each {@link NUXT_HOISTED_TYPES} package, from the module or
 * else from where its Nuxt packages have it, and `#app/nuxt`. Without them a module that depends on `@nuxt/kit` only
 * fails with TS2742 / TS2883 ("cannot be named without a reference to @nuxt/schema").
 */
export async function hoistedTypePaths(
  root: string,
): Promise<Record<string, string[]>> {
  const paths: Record<string, string[]> = {};
  const dirs = await Promise.all(
    NUXT_HOISTED_TYPES.map((name) => hoistedTypeDir(name, root)),
  );
  for (const [i, name] of NUXT_HOISTED_TYPES.entries()) {
    const dir = dirs[i];
    if (!dir) continue;
    paths[name] = [dir];
    paths[`${name}/*`] = [`${dir}/*`];
  }
  const nuxt = await realPackageDirectory('nuxt', root);
  if (nuxt) paths['#app/nuxt'] = [path.join(nuxt, 'dist/app/nuxt')];
  return paths;
}

/**
 * The compiler options the module declaration is emitted with on top of its tsconfig, so TypeScript can name
 * `@nuxt/schema`'s types in it:
 *
 * - `paths` gains {@link hoistedTypePaths} under the tsconfig's own (made absolute: an override replaces them
 *   wholesale), so the package has a bare name that maps to where it is installed;
 * - `types` gains each {@link NUXT_HOISTED_TYPES} package the module resolves itself, so the program holds it under
 *   that name. The declaration program holds just the module entry, which otherwise reaches `@nuxt/schema` only
 *   through `@nuxt/kit`'s own link to it; `nuxt-module-build`'s program holds every file the prepared tsconfig
 *   includes, which reference it by name.
 */
export async function moduleDeclarationOptions(
  root: string,
  tsconfig: string,
): Promise<{ paths?: Record<string, string[]>; types?: string[] }> {
  const ts = await packageTypeScript(root);
  const { options } = parsedTsconfig(ts, tsconfig);
  const result: { paths?: Record<string, string[]>; types?: string[] } = {};
  const own =
    options.types ?? ts.getAutomaticTypeDirectiveNames(options, ts.sys);
  const installed = await Promise.all(
    NUXT_HOISTED_TYPES.map(
      async (n) =>
        !own.includes(n) && Boolean(await realPackageDirectory(n, root)),
    ),
  );
  const types = NUXT_HOISTED_TYPES.filter((_, i) => installed[i]);
  if (types.length > 0) result.types = [...own, ...types];
  const hoisted = await hoistedTypePaths(root);
  if (Object.keys(hoisted).length > 0) {
    result.paths = { ...hoisted, ...absolutePaths(options, tsconfig) };
  }
  return result;
}

/** `<name>.d.ts` copies of each bundled entry's `<name>.d.mts`, for consumers on `node10` resolution. */
export async function writeCompatibleDeclarations(
  outDir: string,
  names: readonly string[],
): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      const mts = path.join(outDir, `${name}.d.mts`);
      if (await exists(mts))
        await writeFile(path.join(outDir, `${name}.d.ts`), await readFile(mts));
    }),
  );
}

/**
 * The per-file runtime and its declarations, written once the module bundle is, like every step
 * after it: nothing of it after a failed build. Listed before {@link nuxtModuleOutputs}, it runs
 * first (steps run in plugin order).
 */
export function nuxtRuntime(options: () => ResolvedOptions): Plugin {
  return afterBuild(`${PLUGIN_PREFIX}:runtime`, async (config) => {
    const o = options();
    if (!o.runtimeDir) return;
    await buildRuntime({
      root: o.root,
      entry: o.entry,
      runtimeDir: o.runtimeDir,
      exclude: o.runtimeExclude,
      extension: o.extension,
      dts: o.dts,
      tsconfig: o.tsconfig,
      outDir: path.resolve(config.root, config.build.outDir),
    });
  });
}

/**
 * After the build: the bundled entries' declarations, `module.json` and, when the package's manifest names it (the
 * module starter's `exports["."].types`), `types.d.mts`: unnamed, no consumer would ever load it.
 */
export function nuxtModuleOutputs(options: () => ResolvedOptions): Plugin {
  return afterBuild(`${PLUGIN_PREFIX}:outputs`, async (config) => {
    const o = options();
    const outDir = path.resolve(config.root, config.build.outDir);
    if (o.dts) {
      const tsconfig = await effectiveTsconfig(o.root, o.tsconfig);
      await emitBundledTypes({
        root: o.root,
        entry: o.entry,
        tsconfig,
        external: o.external,
        exts: [o.extension],
        outDir,
        pinTsconfig: true,
        eager: o.eager,
        allowWarnings: o.allowWarnings,
        sourcemap: o.sourcemap,
        sourceRoot: o.sourceRoot,
        compilerOptions: await moduleDeclarationOptions(o.root, tsconfig),
        chunkFileNames: sharedChunkFileNames,
        plugins: o.runtimeDir
          ? [declarationRuntimeExternals(o.runtimeDir)]
          : [],
      });
      // `module.mjs` → `module.d.mts`; an entry built as `.js` would pair with `.d.ts`.
      if (o.compatible && o.extension === '.mjs')
        await writeCompatibleDeclarations(outDir, Object.keys(o.entry));
    }
    await writeModuleJson({ ...o, outDir });
    if (o.dts) await writeTypesEntry(o.root, outDir, o.extension);
  });
}
