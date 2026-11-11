import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { RolldownWatcher } from 'rolldown';
import { build, type UserConfig } from 'vite';

import './realm.js';
import { type NuxtModuleOptions, nuxtModule } from '../../src/index.js';

const { dirname, join, resolve } = nodePath;

/** This package's own `node_modules`, which every fixture links so it resolves the build tools. */
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- experimental API used on purpose
const OWN_NODE_MODULES = resolve(import.meta.dirname, '../../node_modules');

/** A compiler setup the declaration steps of a fixture can type with. */
export const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'ES2022',
    declaration: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
});

/**
 * A throwaway package on disk (files relative to its root) that resolves this package's own
 * `node_modules`, or, with `link`, only those packages of it (so `files` can install more under
 * `node_modules/`). Its root is the real path: Vite hands module ids over by it (macOS' tmpdir is
 * behind a symlink).
 */
export function fixture(
  files: Record<string, string>,
  options: { readonly link?: readonly string[] } = {},
): string {
  // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vite-fixture-')));
  for (const [name, text] of Object.entries(files)) {
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    mkdirSync(dirname(join(root, name)), { recursive: true });
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    writeFileSync(join(root, name), text);
  }
  if (!options.link) {
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    symlinkSync(OWN_NODE_MODULES, join(root, 'node_modules'), 'dir');
    return root;
  }
  for (const name of options.link) {
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true });
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    symlinkSync(
      join(OWN_NODE_MODULES, name),
      join(root, 'node_modules', name),
      'dir',
    );
  }
  return root;
}

/**
 * Runs one Vite build of the package at `root` with the plugin: no config file and no console
 * output. `vite` is extra Vite config merged on top of the root and the plugin.
 */
export async function buildFixture(
  root: string,
  options: NuxtModuleOptions = {},
  vite: UserConfig = {},
): Promise<void> {
  await build({
    root,
    ...vite,
    plugins: [nuxtModule(options), ...(vite.plugins ?? [])],
    configFile: false,
    logLevel: 'silent',
  });
}

/**
 * Starts `vite build --watch` of the package at `root` with the plugin, like {@link buildFixture}.
 * The caller closes the watcher.
 */
export async function watchFixture(
  root: string,
  options: NuxtModuleOptions = {},
  vite: UserConfig = {},
): Promise<RolldownWatcher> {
  return (await build({
    root,
    ...vite,
    build: { ...vite.build, watch: {} },
    plugins: [nuxtModule(options), ...(vite.plugins ?? [])],
    configFile: false,
    logLevel: 'silent',
  })) as RolldownWatcher;
}

/** A file of a fixture's build output, as text. */
export function output(root: string, file: string): string {
  // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
  return readFileSync(join(root, file), 'utf8');
}

/**
 * X
 * export (`default` or a name) creates `{ name: <package>, options }`, the options it was called
 * with. What a preset loads from the package it builds, without the real tool.
 */
export function withTools(
  pkg: Record<string, unknown>,
  tools: Readonly<Record<string, string>>,
): string {
  // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
  const root = mkdtempSync(join(tmpdir(), 'vite-tools-'));
  // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  for (const [name, exportName] of Object.entries(tools)) {
    const dir = join(root, 'node_modules', name);
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, type: 'module', exports: './index.js' }),
    );
    const factory = `(options) => ({ name: ${JSON.stringify(name)}, options })`;
    // eslint-disable-next-line n/no-sync -- shared test fixture: sync fs keeps its callers in other test files unchanged
    writeFileSync(
      join(dir, 'index.js'),
      exportName === 'default'
        ? `export default ${factory};\n`
        : `export const ${exportName} = ${factory};\n`,
    );
  }
  return root;
}
