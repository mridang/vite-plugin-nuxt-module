import { spawn } from 'node:child_process';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- experimental API used on purpose: test fixture copy, Node 22.0 floor
import { cpSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'vite';

import nuxtModule from '../../src/index.js';
import '../utils/realm.js';

import { FIXTURES, PACKAGE_ROOT } from './paths.js';

const { join } = path;

/** The name the fixture module is published and installed under. */
export const MODULE_NAME = 'hello-timing';

/** The bundled entries the fixture module adds next to `src/module.ts`. */
const MODULE_ENTRIES = {
  server: 'src/server.ts',
  shared: 'src/shared.ts',
} as const;

/** Where a run keeps its copies: inside the package, so they resolve its `node_modules`, and git-ignored. */
export function workDirectory(): string {
  return join(PACKAGE_ROOT, '.out', 'contract', String(process.pid));
}

/** Runs `command`, resolving with its output and rejecting with it when it exits non-zero. */
export function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: typeof process.env },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} ${args.join(' ')} exited with ${code}\n${output}`,
            ),
          ),
    );
  });
}

/** A copy of the fixture `name` in `into`. */
export function copyFixture(name: 'module' | 'app', into: string): string {
  // eslint-disable-next-line n/no-sync -- copyFixture is synchronous: callers use the returned path at once
  cpSync(join(FIXTURES, name), into, { recursive: true });
  return into;
}

/**
 * Builds the module at `moduleDir` with the plugin, as a project's own `vite build` would: the
 * plugin listed in its Vite config, with the module prepared first.
 */
export async function buildModule(moduleDir: string): Promise<void> {
  await build({
    root: moduleDir,
    configFile: false,
    logLevel: 'warn',
    plugins: [nuxtModule({ entry: MODULE_ENTRIES, prepare: true })],
  });
}

/** `npm pack` of the package at `packageDir`, into `into`: the path of the tarball. */
export async function packModule(
  packageDir: string,
  into: string,
): Promise<string> {
  await mkdir(into, { recursive: true });
  await run('npm', ['pack', '--pack-destination', into], { cwd: packageDir });
  const entries = await readdir(into);
  const tarball = entries.find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`npm pack wrote no tarball into ${into}`);
  return join(into, tarball);
}

/** Extracts `tarball` as the package `name` of the app at `appDir`, like an install would. */
export async function installModule(
  tarball: string,
  appDir: string,
  name: string = MODULE_NAME,
): Promise<string> {
  const target = join(appDir, 'node_modules', name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], {
    cwd: appDir,
  });
  return target;
}

/**
 * `nuxi build` in the app at `appDir`, in a process of its own: Nuxt's build loads ES-only packages
 * that Jest's module system cannot `require`. Writes the production server to `.output/`.
 */
export async function buildApp(appDir: string): Promise<void> {
  const nuxi = join(PACKAGE_ROOT, 'node_modules/.bin/nuxi');
  await run(nuxi, ['build'], {
    cwd: appDir,
    env: { NUXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
  });
}

/** `nuxi prepare` in the app at `appDir`: writes `.nuxt/` with the types the installed module adds. */
export async function prepareApp(appDir: string): Promise<void> {
  const nuxi = join(PACKAGE_ROOT, 'node_modules/.bin/nuxi');
  await run(nuxi, ['prepare'], {
    cwd: appDir,
    env: { NUXT_TELEMETRY_DISABLED: '1' },
  });
}

/**
 * The TypeScript errors of `file` in the prepared app at `appDir`, compiled the way Nuxt's
 * generated tsconfig compiles the app: its ambient declarations (the module's types among them)
 * and `file`, formatted as `tsc` prints them.
 */
export function typeErrors(appDir: string, file: string): string[] {
  const tsconfig = join(appDir, '.nuxt/tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!parsed) throw new Error(`cannot read ${tsconfig}`);
  const ambient = parsed.fileNames.filter((name) => /\.d\.[cm]?ts$/.test(name));
  const target = path.resolve(appDir, file);
  const program = ts.createProgram({
    rootNames: [...ambient, target],
    options: parsed.options,
  });
  const source = program.getSourceFile(target);
  if (!source) throw new Error(`${target} is not part of the program`);
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => appDir,
    getNewLine: () => '\n',
  };
  return ts
    .getPreEmitDiagnostics(program, source)
    .map((diagnostic) => ts.formatDiagnostic(diagnostic, host).trimEnd());
}

export { PACKAGE_ROOT } from './paths.js';
