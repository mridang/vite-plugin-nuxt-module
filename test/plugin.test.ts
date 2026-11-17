import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { createLogger } from 'vite';
import { nuxtModule } from '../src/index.js';
import { buildConfig } from '../src/plugin.js';
import { resolveOptions } from '../src/options.js';
import {
  buildFixture,
  FIXTURE_TSCONFIG,
  fixture,
  output,
} from './utils/fixture.js';
import { pathExists } from './utils/fs.js';
import type { ConfigEnv, Logger, Plugin, UserConfig } from 'vite';

const collator = new Intl.Collator();

const PREPARE_TRUE_PATTERN = /prepare: true/u;
const LATE_WARNING_PATTERN = /late warning/u;
const HELPER_IMPORT_PATTERN = /["']\.\.\/lib\/helper\.js["']/u;
const USE_THING_IMPORT_PATTERN =
  /from ["']\.\/runtime\/composables\/useThing\.js["']/u;
const TYPE_ERROR_PATTERN = /type error/u;

/** A fake `@nuxt/cli` whose prepare writes the `.nuxt/tsconfig.json` a real one would. */
const fakeNuxtCli = {
  'node_modules/@nuxt/cli/package.json': JSON.stringify({
    name: '@nuxt/cli',
    type: 'module',
    exports: { '.': './index.mjs' },
  }),
  'node_modules/@nuxt/cli/index.mjs': [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'export const runCommand = async (_command, [cwd]) => {',
    "  await mkdir(join(cwd, '.nuxt'), { recursive: true });",
    "  await writeFile(join(cwd, '.nuxt/tsconfig.json'), '{}');",
    '};',
  ].join('\n'),
};

const DEFAULT_FILES = { 'src/module.ts': '' };

/** A module package: `src/module.ts` and an empty `src/runtime` unless `files` says otherwise. */
async function packageRoot(
  files: Record<string, string> = DEFAULT_FILES,
): Promise<string> {
  const root = await realpath(
    await mkdtemp(nodePath.join(tmpdir(), 'nuxt-module-plugin-')),
  );
  const all = {
    'package.json': JSON.stringify({ name: 'mod', type: 'module' }),
    'tsconfig.json': '{}',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(nodePath.dirname(nodePath.join(root, path)), {
      recursive: true,
    });
    await writeFile(nodePath.join(root, path), content);
  }
  if ('src/module.ts' in files) {
    await mkdir(nodePath.join(root, 'src/runtime'), { recursive: true });
  }
  return root;
}

/** The config hook of the plugin's config plugin, run for the project at `root`. */
async function configFor(
  root: string,
  options: Parameters<typeof nuxtModule>[0] = {},
  user: UserConfig = {},
): Promise<UserConfig> {
  const plugin = nuxtModule(options).find(
    (p) => p.name === 'nuxt-module:config',
  )!;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Vite types the config hook with a plugin context and a union of results, and this test calls it with none because the plugin's hook reads none
  const hook = plugin.config as (
    c: UserConfig,
    env: ConfigEnv,
  ) => Promise<UserConfig>;
  return hook({ root, ...user }, { command: 'build', mode: 'production' });
}

describe('nuxtModule', () => {
  it('is a list of plugins that apply to builds only', () => {
    const plugins = nuxtModule();
    expect(plugins.map((p) => [p.name, p.apply])).toEqual([
      ['nuxt-module:warnings', 'build'],
      ['nuxt-module:config', 'build'],
      ['nuxt-module:runtime-externals', 'build'],
      ['nuxt-module:implicit-dependencies', 'build'],
      ['nuxt-module:no-build-paths', 'build'],
      ['nuxt-module:runtime', 'build'],
      ['nuxt-module:outputs', 'build'],
    ]);
  });

  it('is also the default export of the package', async () => {
    const entry = await import('../src/index.js');
    expect(entry.default).toBe(nuxtModule);
  });
});

describe('the Vite config the plugin adds', () => {
  it('bundles the module as an ES entry for Node', async () => {
    const root = await packageRoot();
    const config = await configFor(root);
    expect([
      config.build?.lib && config.build.lib.entry,
      config.build?.lib && config.build.lib.formats,
      config.build?.ssr,
      config.build?.outDir,
      config.build?.minify,
      config.build?.emptyOutDir,
    ]).toEqual([
      { module: nodePath.join(root, 'src/module.ts') },
      ['es'],
      true,
      'dist',
      false,
      true,
    ]);
  });

  it('bundles extra entries next to the module', async () => {
    const root = await packageRoot();
    const config = await configFor(root, {
      entry: { server: 'src/server.ts' },
    });
    expect(config.build?.lib && config.build.lib.entry).toEqual({
      module: nodePath.join(root, 'src/module.ts'),
      server: nodePath.join(root, 'src/server.ts'),
    });
  });

  it('writes no source maps unless asked, like @nuxt/module-builder', async () => {
    const config = await configFor(await packageRoot());
    expect(config.build?.sourcemap).toBe(false);
  });

  it('names shared chunks like @nuxt/module-builder', async () => {
    const config = await configFor(await packageRoot());
    const chunkOutput = config.build?.rolldownOptions?.output;
    expect(
      Array.isArray(chunkOutput) ? undefined : chunkOutput?.chunkFileNames,
    ).toBe('shared/[name].[hash].mjs');
  });

  it("leaves the settings the project's own Vite config makes to it", async () => {
    const config = await configFor(
      await packageRoot(),
      {},
      {
        build: {
          outDir: 'out',
          minify: true,
          emptyOutDir: false,
          target: 'node22',
        },
      },
    );
    expect([
      config.build?.outDir,
      config.build?.minify,
      config.build?.emptyOutDir,
      config.build?.target,
    ]).toEqual(['out', true, false, 'node22']);
  });

  it('keeps a logger the project set', async () => {
    const customLogger = createLogger('silent');
    const config = await configFor(await packageRoot(), {}, { customLogger });
    expect(config.customLogger).toBeUndefined();
  });

  it('transpiles the module with its own tsconfig', async () => {
    const root = await packageRoot();
    const config = await configFor(root);
    expect(config.tsconfig).toBe(nodePath.join(root, 'tsconfig.json'));
  });

  it('fails before the build when the module is not prepared, saying how to prepare it', async () => {
    const root = await packageRoot({
      'src/module.ts': '',
      'tsconfig.json': '{ "extends": "./.nuxt/tsconfig.json" }',
    });
    await expect(configFor(root)).rejects.toThrow(PREPARE_TRUE_PATTERN);
  });

  it('prepares the module first when prepare is set', async () => {
    const root = await packageRoot({
      'src/module.ts': '',
      'tsconfig.json': '{ "extends": "./.nuxt/tsconfig.json" }',
      ...fakeNuxtCli,
    });
    await configFor(root, { prepare: true });
    expect(await pathExists(nodePath.join(root, '.nuxt/tsconfig.json'))).toBe(
      true,
    );
  }, 30_000);

  it('needs no tsconfig for a build without declarations', async () => {
    const root = await packageRoot();
    await rm(nodePath.join(root, 'tsconfig.json'));
    const config = await configFor(root, { dts: false });
    expect(config.tsconfig).toBeUndefined();
  });

  it('describes the same build whoever calls it', async () => {
    const root = await packageRoot();
    const o = await resolveOptions({}, root);
    const logger = createLogger('silent');
    const awaited1 = await buildConfig(o, {}, logger, { failed: false });
    expect(awaited1.build?.rolldownOptions?.cwd).toBe(root);
  });
});

describe('nuxtModule builds', () => {
  const files = {
    'package.json': JSON.stringify({
      name: 'mod',
      version: '1.2.3',
      type: 'module',
    }),
    'tsconfig.lib.json': FIXTURE_TSCONFIG,
    'src/module.ts':
      'import type { Options } from "./runtime/types.js";\nconst setup = (_o: Options): void => {};\nexport default Object.assign(setup, { getMeta: async () => ({ configKey: "mod" }) });\n',
    'src/index.ts':
      'export { useThing } from "./runtime/composables/useThing.js";\n',
    'src/runtime/types.ts': 'export interface Options { a: number }\n',
    'src/runtime/lib/helper.ts':
      'export interface Helper { n: number }\nexport const helper = (): Helper => ({ n: 1 });\n',
    'src/runtime/composables/useThing.ts':
      'import { type Helper, helper } from "../lib/helper";\nexport const useThing = (): Helper => helper();\n',
    'src/runtime/composables/useOther.ts':
      'export const useOther = (): number => 2;\n',
    'src/runtime/composables/useThing.test.ts': 'export {};\n',
  };
  const entry = { index: 'src/index.ts' };

  it('writes what @nuxt/module-builder writes', async () => {
    const root = await fixture(files);
    await buildFixture(root, { entry });
    const distribution = await readdir(nodePath.join(root, 'dist'));
    const composables = await readdir(
      nodePath.join(root, 'dist/runtime/composables'),
    );
    expect([
      distribution
        .filter((f) => !f.endsWith('.map'))
        .toSorted((a, b) => collator.compare(a, b)),
      composables.toSorted((a, b) => collator.compare(a, b)),
      JSON.parse(await output(root, 'dist/module.json')),
    ]).toEqual([
      [
        'index.d.mts',
        'index.mjs',
        'module.d.mts',
        'module.json',
        'module.mjs',
        'runtime',
      ],
      ['useOther.d.ts', 'useOther.js', 'useThing.d.ts', 'useThing.js'],
      expect.objectContaining({
        configKey: 'mod',
        name: 'mod',
        version: '1.2.3',
      }),
    ]);
  }, 60_000);

  it("writes into the outDir of the project's Vite config", async () => {
    const root = await fixture(files);
    await buildFixture(root, { entry }, { build: { outDir: 'build/out' } });
    expect(await pathExists(nodePath.join(root, 'build/out/module.mjs'))).toBe(
      true,
    );
  }, 60_000);

  it('writes .js entries and .d.ts declarations with extension .js', async () => {
    const root = await fixture(files);
    await buildFixture(root, { entry, extension: '.js' });
    const distribution = await readdir(nodePath.join(root, 'dist'));
    expect(
      distribution
        .filter((f) => !f.endsWith('.map'))
        .toSorted((a, b) => collator.compare(a, b)),
    ).toEqual([
      'index.d.ts',
      'index.js',
      'module.d.ts',
      'module.js',
      'module.json',
      'runtime',
    ]);
  }, 60_000);

  it('writes no runtime after a build that fails on a warning Vite logs once the bundle is written', async () => {
    const root = await fixture(files);
    let logger: Logger | undefined;
    const lateWarning: Plugin = {
      name: 'late-warning',
      configResolved(config) {
        logger = config.logger;
      },
      writeBundle() {
        logger?.warn('late warning');
      },
    };
    await expect(
      buildFixture(root, { entry }, { plugins: [lateWarning] }),
    ).rejects.toThrow(LATE_WARNING_PATTERN);
    expect(await pathExists(nodePath.join(root, 'dist/runtime'))).toBe(false);
  }, 60_000);

  it('gives runtime JS and declarations explicit .js specifiers', async () => {
    const root = await fixture(files);
    await buildFixture(root, { entry });
    expect([
      await output(root, 'dist/runtime/composables/useThing.js'),
      await output(root, 'dist/runtime/composables/useThing.d.ts'),
    ]).toEqual([
      expect.stringContaining('from "../lib/helper.js"'),
      expect.stringMatching(HELPER_IMPORT_PATTERN),
    ]);
  }, 60_000);

  it("types a bundled entry's .js import of a runtime file by importing it, not by copying it", async () => {
    const root = await fixture(files);
    await buildFixture(root, { entry });
    expect(await output(root, 'dist/index.d.mts')).toMatch(
      USE_THING_IMPORT_PATTERN,
    );
  }, 60_000);

  it('fails on a type error in the runtime', async () => {
    const root = await fixture({
      ...files,
      'src/runtime/composables/useOther.ts':
        'export const useOther = (): number => "s";\n',
    });
    await expect(buildFixture(root, { entry })).rejects.toThrow(
      TYPE_ERROR_PATTERN,
    );
  }, 60_000);

  it('writes .d.ts copies of the bundled entries with dts.compatible', async () => {
    const root = await fixture(files);
    await buildFixture(root, { dts: { compatible: true } });
    expect(await pathExists(nodePath.join(root, 'dist/module.d.ts'))).toBe(
      true,
    );
  }, 60_000);

  it('writes no declarations with dts: false', async () => {
    const root = await fixture(files);
    await buildFixture(root, { dts: false });
    expect(await pathExists(nodePath.join(root, 'dist/module.d.mts'))).toBe(
      false,
    );
  }, 60_000);

  it('writes no runtime for a module without one', async () => {
    const root = await fixture(files);
    await buildFixture(root, { runtimeDir: false });
    expect(await pathExists(nodePath.join(root, 'dist/runtime'))).toBe(false);
  }, 60_000);

  it('writes source maps when asked', async () => {
    const root = await fixture(files);
    await buildFixture(root, { sourcemap: true });
    expect(await pathExists(nodePath.join(root, 'dist/module.mjs.map'))).toBe(
      true,
    );
  }, 60_000);
});
