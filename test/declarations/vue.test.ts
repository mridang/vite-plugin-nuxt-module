import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { FIXTURE_TSCONFIG, fixture } from '../utils/fixture.js';
import { requiredVueTools, vueTools } from '../../src/declarations/vue.js';

const { join } = path;

afterEach(() => {
  jest.resetModules();
});

describe('vueTools', () => {
  it("loads the TypeScript vue-tsc runs on, not the package's own copy", async () => {
    const vueTsc = createRequire(import.meta.url).resolve(
      'vue-tsc/package.json',
    );
    const tools = await vueTools(await fixture({ 'package.json': '{}' }));
    expect(tools?.ts).toBe(createRequire(vueTsc)('typescript'));
  });

  it('creates a program that reads the .vue files the sources import', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'fx', type: 'module' }),
      'tsconfig.json': JSON.stringify({
        ...JSON.parse(FIXTURE_TSCONFIG),
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }),
      'src/Comp.vue':
        '<script setup lang="ts">\nconst label: string = 1;\n</script>\n',
      'src/index.ts': 'export { default as Comp } from "./Comp.vue";\n',
    });
    const tools = await vueTools(root);
    const tsconfig = join(root, 'tsconfig.json');
    const options = {
      strict: true,
      noEmit: true,
      target: tools?.ts.ScriptTarget.ES2022,
      types: [],
    };
    const program = tools?.createProgram(tsconfig)({
      rootNames: [join(root, 'src/index.ts')],
      options,
      host: tools.ts.createCompilerHost(options),
    });
    const errors = program && tools?.ts.getPreEmitDiagnostics(program);
    expect(errors?.map((d) => d.code)).toEqual([2322]);
  });

  it('is undefined without vue-tsc', async () => {
    jest.unstable_mockModule('node:module', () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Cannot find module 'vue-tsc/package.json'");
        },
      }),
    }));
    const { vueTools: withoutVueTsc } =
      await import('../../src/declarations/vue.js');
    expect(await withoutVueTsc(tmpdir())).toBeUndefined();
  });
});

describe('requiredVueTools', () => {
  it('returns the tools when vue-tsc is installed', async () => {
    const tools = await requiredVueTools(tmpdir(), 'typing .vue files');
    expect(tools.ts).toBeDefined();
  });

  it('names what to install when vue-tsc is not', async () => {
    jest.unstable_mockModule('node:module', () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Cannot find module 'vue-tsc/package.json'");
        },
      }),
    }));
    const { requiredVueTools: withoutVueTsc } =
      await import('../../src/declarations/vue.js');
    await expect(
      withoutVueTsc(
        tmpdir(),
        'declarations: .vue sources are typed by vue-tsc',
      ),
    ).rejects.toThrow(
      'declarations: .vue sources are typed by vue-tsc; install vue-tsc',
    );
  });
});
