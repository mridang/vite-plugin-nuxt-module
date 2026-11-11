import { mkdir, readdir, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  buildFixture,
  FIXTURE_TSCONFIG,
  fixture,
  output,
  withTools,
} from './utils/fixture.js';
import {
  buildRuntime,
  declarationRuntimeExternals,
  renderRuntimeSpecifiers,
  runtimeFiles,
  runtimeImportTypes,
} from '../src/runtime.js';
import { pathExists } from './utils/fs.js';

const { join } = nodePath;

/** A module root with `files` under it and a fake Sass that wraps the source in a comment. */
async function moduleRoot(files: Record<string, string>): Promise<string> {
  const root = await withTools({ name: 'mod', type: 'module' }, {});
  const sass = join(root, 'node_modules/sass');
  await mkdir(sass, { recursive: true });
  await writeFile(
    join(sass, 'package.json'),
    JSON.stringify({ name: 'sass', type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(sass, 'index.js'),
    'import { readFileSync } from "node:fs";\nexport const compile = (file) => ({ css: `/* compiled */ ${readFileSync(file, "utf8")}` });\nexport const compileString = () => ({ css: "" });\n',
  );
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text);
  }
  await writeFile(join(root, 'tsconfig.json'), '{}');
  return root;
}

describe('runtimeFiles', () => {
  it('leaves out tests, stories and the excluded globs', async () => {
    const root = await moduleRoot({
      'src/runtime/a.ts': '',
      'src/runtime/a.test.ts': '',
      'src/runtime/b.stories.ts': '',
      'src/runtime/__tests__/c.ts': '',
      'src/runtime/fixtures/d.ts': '',
    });
    expect(runtimeFiles(join(root, 'src/runtime'), ['fixtures/**'])).toEqual([
      'a.ts',
    ]);
  });
});

describe('buildRuntime', () => {
  const build = async (root: string) =>
    buildRuntime({
      root,
      entry: {},
      runtimeDir: join(root, 'src/runtime'),
      exclude: [],
      extension: '.mjs',
      dts: false,
      tsconfig: join(root, 'tsconfig.json'),
      outDir: join(root, 'dist'),
    });

  it('compiles Sass to CSS like mkdist, leaving partials and source stylesheets out', async () => {
    const root = await moduleRoot({
      'src/runtime/style.scss': "@use 'partial';",
      'src/runtime/_partial.scss': 'a { b: c }',
    });
    await build(root);
    expect([
      await readdir(join(root, 'dist/runtime')),
      await output(root, 'dist/runtime/style.css'),
    ]).toEqual([['style.css'], "/* compiled */ @use 'partial';"]);
  });

  it('transpiles scripts with explicit specifiers and copies other files', async () => {
    const root = await moduleRoot({
      'src/runtime/plugin.ts':
        'import { x } from "./lib/x";\nexport default (): number => x;\n',
      'src/runtime/lib/x.ts': 'export const x: number = 1;\n',
      'src/runtime/data.json': '{}',
    });
    await build(root);
    expect([
      await output(root, 'dist/runtime/plugin.js'),
      await pathExists(join(root, 'dist/runtime/data.json')),
    ]).toEqual([expect.stringContaining('from "./lib/x.js"'), true]);
  });

  it('ships a hand-written declaration as written', async () => {
    const root = await moduleRoot({
      'src/runtime/types.d.ts': 'export interface A {}',
    });
    await build(root);
    expect(await output(root, 'dist/runtime/types.d.ts')).toBe(
      'export interface A {}',
    );
  });
});

describe('declarationRuntimeExternals', () => {
  const resolveId = (root: string, id: string) =>
    (
      (
        declarationRuntimeExternals(join(root, 'src/runtime')) as {
          resolveId: unknown;
        }
      ).resolveId as (
        id: string,
        importer: string,
      ) => { id: string; external: boolean } | null
    )(id, join(root, 'src/index.ts'));

  it.each([['./runtime/composables/use'], ['./runtime/composables/use.js']])(
    'imports the runtime file %s is written for instead of inlining its types',
    async (id) => {
      const root = await moduleRoot({
        'src/runtime/composables/use.ts': '',
        'src/index.ts': '',
      });
      expect(resolveId(root, id)).toEqual({
        id: 'nuxt-module-runtime:composables/use.js',
        external: true,
      });
    },
  );

  it('keeps a package import external', async () => {
    expect(resolveId(await moduleRoot({}), 'h3')).toEqual({
      id: 'h3',
      external: true,
    });
  });
});

describe('renderRuntimeSpecifiers', () => {
  it.each([
    ['index.mjs', './runtime/x.js'],
    ['utils/headers.mjs', '../runtime/x.js'],
    ['shared/a.b.mjs', '../runtime/x.js'],
  ])('imports a runtime file from %s as %s', (fileName, expected) => {
    expect(
      renderRuntimeSpecifiers(
        'import { x } from "nuxt-module-runtime:x.js";',
        fileName,
      )?.code,
    ).toBe(`import { x } from "${expected}";`);
  });

  it('leaves a chunk without runtime imports alone', () => {
    expect(
      renderRuntimeSpecifiers('import { x } from "./x.mjs";', 'index.mjs'),
    ).toBeNull();
  });
});

describe('runtimeImportTypes', () => {
  it("names the runtime file of an inferred import type, whatever the declaring file's directory", async () => {
    const root = await moduleRoot({ 'src/runtime/x.ts': '' });
    expect(
      runtimeImportTypes(
        'export declare const a: () => import("../runtime/x").X;',
        join(root, 'src/deep/a.d.ts'),
        join(root, 'src/runtime'),
      ),
    ).toBe(
      'export declare const a: () => import("nuxt-module-runtime:x.js").X;',
    );
  });
});

describe('runtime imports of bundled entries', () => {
  const files = {
    'package.json': JSON.stringify({
      name: 'mod',
      version: '1.0.0',
      type: 'module',
    }),
    'tsconfig.lib.json': FIXTURE_TSCONFIG,
    'src/runtime/x.ts':
      'export interface X {\n  n: number;\n}\nexport const makeX = (): X => ({ n: 1 });\n',
    'src/shared.ts':
      'import { makeX, type X } from "./runtime/x";\nexport const shared = (): X => makeX();\n',
    'src/deep/a.ts':
      'import { shared } from "../shared";\nexport { makeX } from "../runtime/x";\nexport const a = () => shared();\n',
    'src/other.ts':
      'import { shared } from "./shared";\nexport const other = () => shared();\n',
    'src/module.ts':
      'import { makeX } from "./runtime/x";\nexport default Object.assign((): void => {}, { getMeta: async () => ({ configKey: "mod" }), make: () => makeX() });\n',
  };
  const built = async () => {
    const root = await fixture(files);
    await buildFixture(
      root,
      { entry: { 'utils/a': 'src/deep/a.ts', other: 'src/other.ts' } },
      { build: { outDir: 'build/out' } },
    );
    const out = join(root, 'build/out');
    const chunks = await readdir(join(out, 'shared'));
    const shared = chunks.find((f) => f.endsWith('.mjs')) ?? '';
    return { out, shared };
  };

  it('imports them relative to each chunk under a nested output directory', async () => {
    const { out, shared } = await built();
    expect([
      await output(out, 'module.mjs'),
      await output(out, 'utils/a.mjs'),
      await output(out, `shared/${shared}`),
    ]).toEqual([
      expect.stringContaining('from "./runtime/x.js"'),
      expect.stringContaining('from "../runtime/x.js"'),
      expect.stringContaining('from "../runtime/x.js"'),
    ]);
  }, 60_000);

  it('types them relative to each declaration, written or inferred', async () => {
    const { out } = await built();
    expect([
      await output(out, 'module.d.mts'),
      await output(out, 'utils/a.d.mts'),
    ]).toEqual([
      expect.stringContaining('import("./runtime/x.js").X'),
      expect.stringMatching(/from ["']\.\.\/runtime\/x\.js["']/),
    ]);
  }, 60_000);
});

/** A module package of `files` (a `package.json` unless given) that installs this package's own TypeScript. */
async function tree(files: Record<string, string>): Promise<string> {
  return await fixture(
    {
      'package.json': JSON.stringify({ name: 'mod', type: 'module' }),
      ...files,
    },
    { link: ['typescript'] },
  );
}

/** A tsconfig as `nuxi prepare` leaves a module: extending the generated one, whose `paths` hold `/*`. */
const prepared = {
  'tsconfig.json':
    '{\n  // https://nuxt.com/docs/guide/concepts/typescript\n  "extends": "./.nuxt/tsconfig.json"\n}\n',
  '.nuxt/tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        types: [],
        paths: { '~/*': ['../*'], '#app': ['./app'] },
      },
      include: ['../src'],
    },
    null,
    2,
  ).replace('"include"', '/* generated by Nuxt */ "include"'),
  '.nuxt/app.d.ts': 'export interface NuxtApp { version: string }\n',
};

/** A fake Sass whose output names the file it compiled. */
const fakeSass = {
  'node_modules/sass/package.json': JSON.stringify({
    name: 'sass',
    type: 'module',
    exports: { '.': './index.mjs' },
  }),
  'node_modules/sass/index.mjs':
    'import { basename } from "node:path";\nexport const compile = (file) => ({ css: `/* compiled ${basename(file)} */` });\nexport const compileString = () => ({ css: "" });\n',
};

async function buildPrepared(root: string, dts = false): Promise<void> {
  let tsconfig: string | undefined;
  await buildRuntime({
    root,
    entry: { module: join(root, 'src/module.ts') },
    runtimeDir: join(root, 'src/runtime'),
    exclude: [],
    extension: '.mjs',
    dts,
    tsconfig,
    outDir: join(root, 'dist'),
  });
}

const built = async (root: string, file: string) =>
  await output(root, join('dist/runtime', file));

describe('buildRuntime of a prepared module', () => {
  it("keeps a declared class field under a prepared module's tsconfig (useDefineForClassFields)", async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/counter.ts':
        'export class Counter {\n  count!: number;\n}\n',
    });
    await buildPrepared(root);
    expect(await built(root, 'counter.js')).toMatch(/^[ \t]*count;$/m);
  });

  it('drops a declared class field when the tsconfig turns useDefineForClassFields off', async () => {
    const root = await tree({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ESNext', useDefineForClassFields: false },
      }),
      'src/runtime/counter.ts':
        'export class Counter {\n  count!: number;\n}\n',
    });
    await buildPrepared(root);
    expect(await built(root, 'counter.js')).not.toMatch(/^[ \t]*count;$/m);
  });

  it('fails when the module was not prepared, instead of guessing its compiler options', async () => {
    const root = await tree({
      'tsconfig.json': prepared['tsconfig.json'],
      'src/runtime/counter.ts': 'export class Counter {}\n',
    });
    await expect(buildPrepared(root)).rejects.toThrow(/nuxi prepare/);
  });

  it("compiles a runtime stylesheet to CSS with the module's own Sass", async () => {
    const root = await tree({
      ...prepared,
      ...fakeSass,
      'src/runtime/assets/main.scss': 'a { b: c }',
    });
    await buildPrepared(root);
    expect([
      await built(root, 'assets/main.css'),
      await pathExists(join(root, 'dist/runtime/assets/main.scss')),
    ]).toEqual(['/* compiled main.scss */', false]);
  });

  it('ships no Sass partial', async () => {
    const root = await tree({
      ...prepared,
      ...fakeSass,
      'src/runtime/assets/_vars.scss': '$c: red;',
      'src/runtime/assets/main.scss': 'a { b: c }',
    });
    await buildPrepared(root);
    expect(await pathExists(join(root, 'dist/runtime/assets/_vars.scss'))).toBe(
      false,
    );
  });

  it("points a script's import of a runtime stylesheet at the compiled CSS", async () => {
    const root = await tree({
      ...prepared,
      ...fakeSass,
      'src/runtime/assets/main.scss': 'a { b: c }',
      'src/runtime/plugin.ts':
        'import "./assets/main.scss";\nexport const ok = true;\n',
    });
    await buildPrepared(root);
    expect(await built(root, 'plugin.js')).toContain('"./assets/main.css"');
  });

  it('declares a runtime .js file', async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/utils/plain.js':
        'export function plain(a) {\n  return a;\n}\n',
    });
    await buildPrepared(root, true);
    expect(await built(root, 'utils/plain.d.ts')).toContain(
      'export function plain(a: any): any;',
    );
  });

  it('ships a hand-written declaration of a runtime .js file as written', async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/utils/plain.js':
        'export function plain(a) {\n  return a;\n}\n',
      'src/runtime/utils/plain.d.ts':
        'export declare function plain(a: string): string;\n',
    });
    await buildPrepared(root, true);
    expect(await built(root, 'utils/plain.d.ts')).toBe(
      'export declare function plain(a: string): string;\n',
    );
  });

  it('fails when a runtime declaration cannot be emitted', async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/make.ts':
        'export const make = () => class {\n  private secret = 1;\n};\n',
    });
    await expect(buildPrepared(root, true)).rejects.toThrow(
      /cannot emit declarations for the runtime/,
    );
  });

  it('leaves type errors to the type check', async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/wrong.ts':
        'export const n: number = "one" as unknown as string;\n',
    });
    await buildPrepared(root, true);
    expect(await built(root, 'wrong.d.ts')).toContain(
      'export declare const n: number;',
    );
  });

  it('names nuxt/app instead of #app in the runtime declarations', async () => {
    const root = await tree({
      ...prepared,
      'src/runtime/app.ts':
        'import type { NuxtApp } from "#app";\nexport const version = (app: NuxtApp): string => app.version;\nexport type App = NuxtApp;\n',
    });
    await buildPrepared(root, true);
    expect(await built(root, 'app.d.ts')).toContain('from "nuxt/app"');
  });
});
