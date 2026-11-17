import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { version } from 'vite';

import { MODULE_JSON } from './defaults.js';
import { parsePackageJson, readPackageJson } from './package-json.js';
import { isRecord } from './is-record.js';

/** What a built Nuxt module's default export may tell about itself. */
interface ModuleExport {
  readonly default?: {
    readonly getMeta?: () =>
      Promise<Record<string, unknown>> | Record<string, unknown>;
  };
}

/** The `name` and `version` of this package, read from the manifest next to `src` / `dist`. */
async function ownPackage(): Promise<{
  readonly name: string;
  readonly version: string;
}> {
  const { name, version: ownVersion } = parsePackageJson(
    await readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  );
  if (name === undefined || ownVersion === undefined) {
    throw new TypeError(
      'the package.json of this package has no name or version',
    );
  }
  return { name, version: ownVersion };
}

/** Whether a loaded module has the shape of {@link ModuleExport}: a default export that may offer `getMeta`. */
function isModuleExport(value: unknown): value is ModuleExport {
  if (!isRecord(value)) {
    return false;
  }
  const exported = value.default;
  if (exported === undefined) {
    return true;
  }
  // A Nuxt module is a function that carries `getMeta`, so the default export may be either.
  if (typeof exported !== 'function' && !isRecord(exported)) {
    return false;
  }
  return !('getMeta' in exported) || typeof exported.getMeta === 'function';
}

/** The tools a module was built with, as `module.json` records them: this plugin and Vite. */
export async function builderMeta(): Promise<Record<string, string>> {
  const own = await ownPackage();
  return { [own.name]: own.version, vite: version };
}

/**
 * The `module.json` of a built module: what its `getMeta()` returns, the package's name and version
 * where it gives none, the builder, then `extra`.
 */
export async function moduleJson(
  meta: Readonly<Record<string, unknown>>,
  pkg: { readonly name?: string; readonly version?: string },
  extra: Readonly<Record<string, unknown>> | undefined,
): Promise<Record<string, unknown>> {
  return {
    ...meta,
    ...(meta.name ? {} : { name: pkg.name }),
    ...(meta.version ? {} : { version: pkg.version }),
    builder: await builderMeta(),
    ...extra,
  };
}

/** Imports the built `module<extension>` from `outDir` and writes its `module.json` next to it. */
export async function writeModuleJson(o: {
  readonly root: string;
  readonly outDir: string;
  readonly extension: string;
  readonly moduleMeta: Readonly<Record<string, unknown>> | undefined;
}): Promise<void> {
  const file = path.join(o.outDir, `module${o.extension}`);
  // eslint-disable-next-line no-unsanitized/method -- loads the module this build just wrote
  const loadedModule: unknown = await import(
    `${pathToFileURL(file).href}?t=${Date.now()}`
  );
  const meta = isModuleExport(loadedModule)
    ? ((await loadedModule.default?.getMeta?.()) ?? {})
    : {};
  const json = await moduleJson(
    meta,
    await readPackageJson(o.root),
    o.moduleMeta,
  );
  await writeFile(
    path.join(o.outDir, MODULE_JSON),
    JSON.stringify(json, null, 2),
  );
}
