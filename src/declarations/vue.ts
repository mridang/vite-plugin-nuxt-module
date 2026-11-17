import { createRequire } from 'node:module';
import path from 'node:path';
import { realPackageDirectory, requireFrom } from '../resolve.js';
import type {
  CompilerOptions,
  CreateProgramOptions,
  ParseConfigHost,
} from 'typescript';

import type { TS } from '../tsconfig.js';

/** A Volar language plugin, as `@vue/language-core` builds it and `@volar/typescript` consumes it. */
type VueLanguagePlugin = Readonly<Record<string, unknown>>;

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
  ): VueLanguagePlugin;
}

/** The part of `@volar/typescript` (a `vue-tsc` dependency) a Vue program needs. */
interface VolarTypescript {
  proxyCreateProgram(
    ts: TS,
    original: TS['createProgram'],
    create: (ts: TS, options: CreateProgramOptions) => VueLanguagePlugin[],
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
  const vueTscDir =
    (await realPackageDirectory('vue-tsc', root)) ??
    ((): string | undefined => {
      try {
        return path.dirname(
          createRequire(import.meta.url).resolve('vue-tsc/package.json'),
        );
      } catch {
        return undefined;
      }
    })();
  if (vueTscDir === undefined) {
    return undefined;
  }
  const fromVueTsc = requireFrom(vueTscDir);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- require returns the compiler installed next to vue-tsc, and nothing can check that it is the version the types describe
  const ts = fromVueTsc('typescript') as TS;
  return {
    ts,
    createProgram(tsconfig) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- require returns the language core installed next to vue-tsc, and nothing can check that it is the version the types describe
      const core = fromVueTsc('@vue/language-core') as VueLanguageCore;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- require returns the Volar package installed next to vue-tsc, and nothing can check that it is the version the types describe
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
  if (!tools) {
    throw new Error(`${what}; install vue-tsc`);
  }
  return tools;
}
