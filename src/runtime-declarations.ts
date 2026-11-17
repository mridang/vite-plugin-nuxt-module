import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { searchForWorkspaceRoot } from 'vite';

import { CONSUMER_COMPILER_OPTIONS, RUNTIME_OUT_DIR } from './defaults.js';
import { posixPath } from './entries.js';
import { assertNoBuildPaths } from './no-build-paths.js';
import { requiredVueTools } from './declarations/vue.js';
import { packageTypeScript } from './resolve.js';
import { parsedTsconfig } from './tsconfig.js';
import {
  applyEdits,
  rewriteDeclarationImports,
  specifierEdits,
} from './specifiers.js';
import { effectiveTsconfig } from './nuxt-tsconfig.js';
import type { SpecifierScope } from './specifiers.js';
import type TS from 'typescript';

const SCRIPT_EXTENSION_PATTERN = /\.([mc])?[jt]sx?$/u;
const NUXT_APP_SPECIFIER_PATTERN = /^#app(\/|$)/u;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/u;
const VUE_DECLARATION_SUFFIX_PATTERN = /\.vue\.d\.ts$/u;

const exists = async (file: string): Promise<boolean> =>
  access(file)
    .then(() => true)
    .catch(() => false);

/** What the runtime declaration step needs. */
export interface RuntimeDeclarationsOptions {
  readonly root: string;
  readonly runtimeDir: string;
  readonly outDir: string;
  readonly tsconfig: string | undefined;
  readonly scope: SpecifierScope;
}

/** Where a source file's declaration is written by TypeScript (no `outDir`): next to it. */
export function declarationFileOf(file: string): string {
  if (file.endsWith('.vue')) {
    return `${file}.d.ts`;
  }
  return file.replace(SCRIPT_EXTENSION_PATTERN, '.d.$1ts');
}

/**
 * `#app` / `#app/*` are aliases only a Nuxt build resolves: a shipped declaration naming them breaks `tsc` for every
 * consumer. `nuxt/app` re-exports them under a name any resolver finds (what `nuxt-module-build` rewrites them to).
 */
export async function rewriteRuntimeTypeAliases(code: string): Promise<string> {
  return applyEdits(
    code,
    await specifierEdits(code, 'dts', (spec) =>
      NUXT_APP_SPECIFIER_PATTERN.test(spec) ? 'nuxt/app' : undefined,
    ),
  );
}

/**
 * The options of the declaration emit: the module's own tsconfig over `mkdist`'s defaults, emitting declarations only,
 * in memory (no `outDir` / `rootDir`, so runtime files may import sources outside the runtime directory), and
 * resolving dependencies through their published types like a consumer.
 */
export function declarationCompilerOptions(
  options: TS.CompilerOptions,
): TS.CompilerOptions {
  // Dropped from `own`: the options that place files on disk, which an in-memory emit must not inherit.
  const own = Object.fromEntries(
    Object.entries(options).filter(
      ([key]) =>
        ![
          'outDir',
          'declarationDir',
          'rootDir',
          'outFile',
          'composite',
          'incremental',
          'tsBuildInfoFile',
        ].includes(key),
    ),
  ) as TS.CompilerOptions;
  return {
    skipLibCheck: true,
    strictNullChecks: true,
    allowImportingTsExtensions: true,
    ...own,
    ...CONSUMER_COMPILER_OPTIONS,
    allowJs: true,
    allowNonTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
  };
}

/** TypeScript's "cannot find module" diagnostics: an import whose types a declaration would lose to `any`. */
const UNRESOLVED_MODULE_CODES: ReadonlySet<number> = new Set([2307, 2792]);

/**
 * `.d.ts` for the transpiled runtime, emitted in process like `mkdist` does: one program over the runtime's scripts
 * (`.js` included) and its `.vue` files, read through `vue-tsc` (see `vueTools`), with the ambient declarations the
 * tsconfig compiles with (a `declare module "#imports"` shim). A runtime with `.vue` files fails without it (`mkdist`
 * warns and ships those components untyped). A declaration the compiler cannot emit for a runtime file fails the
 * build, as `nuxt-module-build` fails it, and so does an import it cannot resolve (`#imports` before `prepare`), whose
 * types the declaration would silently lose to `any`; other type errors do not (type checking is its own step).
 * Relative specifiers then get explicit extensions, like `mkdist`'s `addRelativeDeclarationExtensions`, and `#app`
 * imports become `nuxt/app`. A declaration that names the build machine's paths fails the build too.
 */
export async function emitRuntimeDeclarations(
  o: RuntimeDeclarationsOptions,
  scripts: readonly string[],
  vues: readonly string[],
): Promise<void> {
  const out = path.join(o.outDir, RUNTIME_OUT_DIR);
  const tsconfig = await effectiveTsconfig(o.root, o.tsconfig);
  const vue =
    vues.length > 0
      ? await requiredVueTools(
          o.root,
          `nuxtModule: the runtime has .vue files (${vues.map((f) => path.relative(o.runtimeDir, f)).join(', ')}) to type`,
        )
      : undefined;
  const ts = vue?.ts ?? (await packageTypeScript(o.root));
  const inputs = [...scripts, ...vues].map((f) => path.resolve(f));
  if (inputs.length > 0) {
    const project = parsedTsconfig(ts, tsconfig);
    const options = declarationCompilerOptions(project.options);
    const ambient = project.fileNames.filter((f) =>
      DECLARATION_FILE_PATTERN.test(f),
    );
    const host = ts.createCompilerHost(options);
    const written = new Map<string, string>();
    // eslint-disable-next-line functional/immutable-data -- the compiler host's writeFile is replaced to keep the emit in memory
    host.writeFile = (name, text) => {
      // eslint-disable-next-line functional/immutable-data -- collects what the compiler emits
      written.set(path.resolve(name), text);
    };
    const createProgram = vue ? vue.createProgram(tsconfig) : ts.createProgram;
    const program = createProgram({
      rootNames: [...inputs, ...ambient],
      options,
      host,
    });
    const unresolved = inputs.flatMap((input) => {
      const file = program.getSourceFile(input);
      return file
        ? program
            .getSemanticDiagnostics(file)
            .filter((d) => UNRESOLVED_MODULE_CODES.has(d.code))
        : [];
    });
    if (unresolved.length > 0) {
      throw new Error(
        `nuxtModule: the runtime imports modules TypeScript cannot resolve, whose types its declarations would lose:\n${ts.formatDiagnostics(unresolved, host)}Run \`nuxi prepare\` (or set \`prepare: true\`) with a tsconfig that extends .nuxt/tsconfig.json, or declare them in the tsconfig's files.`,
      );
    }
    const result = program.emit();
    const own = new Set(inputs);
    const shipped: [string, string][] = [];
    const failures = result.diagnostics.filter(
      (d) => d.file && own.has(path.resolve(d.file.fileName)),
    );
    if (failures.length > 0) {
      throw new Error(
        `nuxtModule: cannot emit declarations for the runtime:\n${ts.formatDiagnostics(failures, host)}`,
      );
    }
    // eslint-disable-next-line functional/no-loop-statements -- the files are written one after another, in order
    for (const input of inputs) {
      // A declaration written by hand next to its source (`plain.js` + `plain.d.ts`) is shipped as written.
      if (await exists(declarationFileOf(input))) {
        continue;
      }
      const relativePath = path.relative(
        o.runtimeDir,
        declarationFileOf(input),
      );
      const text = written.get(declarationFileOf(input));
      if (text === undefined) {
        throw new Error(`nuxtModule: no declaration was emitted for ${input}`);
      }
      const destination = path.join(out, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const code = await rewriteRuntimeTypeAliases(
        await rewriteDeclarationImports(
          text,
          path.join(o.runtimeDir, relativePath),
          o.scope,
        ),
      );
      await writeFile(destination, code);
      // eslint-disable-next-line functional/immutable-data -- collects what this loop writes
      shipped.push([destination, code]);
      // vue-tsc names these `X.vue.d.ts`; newer TS tooling also looks for `X.d.vue.ts`.
      if (relativePath.endsWith('.vue.d.ts')) {
        await writeFile(
          path.join(
            out,
            relativePath.replace(VUE_DECLARATION_SUFFIX_PATTERN, '.d.vue.ts'),
          ),
          code,
        );
      }
    }
    assertNoBuildPaths(shipped, posixPath(searchForWorkspaceRoot(o.root)));
  }
}
