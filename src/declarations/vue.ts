import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  CompilerOptions,
  CreateProgramOptions,
  ParseConfigHost,
} from 'typescript';

import { realPackageDirectory, requireFrom } from '../resolve.js';
import type { TS } from '../tsconfig.js';

/** The part of `@vue/language-core` (a `vue-tsc` dependency) a Vue program needs. */
interface VueLanguageCore {
  createParsedCommandLine(
    ts: TS,
    host: ParseConfigHost,
    file: string,
  ): {
    readonly vueOptions: unknown;
  };
  createVueLanguagePlugin(
    ts: TS,
    options: CompilerOptions,
    vueOptions: unknown,
    asFileName: (id: string) => string,
  ): unknown;
}

/** The part of `@volar/typescript` (a `vue-tsc` dependency) a Vue program needs. */
interface VolarTypescript {
  proxyCreateProgram(
    ts: TS,
    original: TS['createProgram'],
    create: (ts: TS, options: CreateProgramOptions) => unknown[],
  ): TS['createProgram'];
}

/** Vue's language tools: `vue-tsc`'s TypeScript and a `createProgram` that reads `.vue` files. */
export interface VueTools {
  readonly ts: TS;
  /** `createProgram` reading `.vue` files through Vue's language tooling, as `vue-tsc` (and `mkdist`) do. */
  createProgram(tsconfig: string): TS['createProgram'];
}

/**
 * Vue's language tools, from the `vue-tsc` the module at `root` has installed, else the one this
 * package resolves (an optional peer), or `undefined` when there is none. The runtime's
 * declarations and their type check use this one copy, so a `.vue` file is never read by two
 * versions.
 */
export async function vueTools(root: string): Promise<VueTools | undefined> {
  let vueTscDir = await realPackageDirectory('vue-tsc', root);
  if (vueTscDir === undefined) {
    try {
      vueTscDir = path.dirname(
        createRequire(import.meta.url).resolve('vue-tsc/package.json'),
      );
    } catch {
      return undefined;
    }
  }
  const fromVueTsc = requireFrom(vueTscDir);
  const ts = fromVueTsc('typescript') as TS;
  return {
    ts,
    createProgram(tsconfig) {
      const core = fromVueTsc('@vue/language-core') as VueLanguageCore;
      const volar = fromVueTsc('@volar/typescript') as VolarTypescript;
      const { vueOptions } = core.createParsedCommandLine(ts, ts.sys, tsconfig);
      return volar.proxyCreateProgram(
        ts,
        ts.createProgram,
        (tsModule, programOptions) => [
          core.createVueLanguagePlugin(
            tsModule,
            programOptions.options,
            vueOptions,
            (id) => id,
          ),
        ],
      );
    },
  };
}

/** {@link vueTools}, or a failure naming what to install for `what`. */
export async function requiredVueTools(
  root: string,
  what: string,
): Promise<VueTools> {
  const tools = await vueTools(root);
  if (!tools) throw new Error(`${what}; install vue-tsc`);
  return tools;
}
