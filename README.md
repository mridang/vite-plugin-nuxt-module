# Vite Plugin - Nuxt Module

A Vite plugin that builds a [Nuxt module](https://nuxt.com/docs/guide/going-further/modules) the
way `nuxt-module-build build` (`@nuxt/module-builder`) does, from the module's own Vite config.

### Why?

Nuxt's own `nuxt-module-build` (`@nuxt/module-builder`) builds a module with `unbuild`. When the rest of
a project already builds with Vite, the module becomes the one package with a different toolchain, a
different config file and a different plugin set. This plugin builds the module from the same Vite
config as everything else, and writes the files module-builder does: the bundled module, the
`runtime/` folder transpiled file by file, `module.json` and `types.d.mts`.

## Installation

Install using NPM with the following command:

```sh
npm install --save-dev @mridang/vite-plugin-nuxt-module
```

## Usage

Add the plugin to the module's Vite config:

```ts
// vite.config.ts
import nuxtModule from '@mridang/vite-plugin-nuxt-module';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [nuxtModule({ entry: { server: 'src/server.ts' } })],
});
```

`vite build` then writes, into `dist/`:

| File                         | What it is                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `module.mjs`, `module.d.mts` | The module (`src/module.ts`), bundled, with its declarations bundled too.                                            |
| `<name>.mjs`, `<name>.d.mts` | One per extra `entry`, bundled the same way. Code the entries share goes to `shared/`.                               |
| `runtime/**`                 | The runtime directory (`src/runtime`), **file by file**: the consuming Nuxt app compiles it, so it is never bundled. |
| `module.json`                | What the module's `getMeta()` returns, plus the package name and version, and what built it.                         |
| `types.d.mts`                | The module starter's type entry (`ModuleOptions`, the hook and runtime config shims), when `package.json` names it.  |

The options are described [below](#options).

## Requirements

- Vite 8 or newer (it builds with Rolldown), Node 22 or newer.
- TypeScript, for the declarations and the runtime's transpile settings.

Everything else is loaded from the module being built, so each version is the one it declares, and
each is needed only for the feature that uses it:

| Tool                        | Needed for                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `nuxt` (its `@nuxt/cli`)    | `prepare: true`                                                                                                   |
| `@nuxt/kit`, `@nuxt/schema` | Typing `defineNuxtModule()`; the module imports `@nuxt/kit` itself                                                |
| `vue-tsc`                   | Declarations for `.vue` files in the runtime                                                                      |
| `vue-sfc-transformer`       | `.vue` files in the runtime: strips their TypeScript. Falls back to the copy `@nuxt/module-builder` brings.       |
| `sass` or `sass-embedded`   | Sass in the runtime (`.scss` / `.sass` files, `<style lang="scss">`), compiled so the consuming app needs no Sass |

They are optional peer dependencies of this package.

## What it does

- **Bundles the module for Node.** Declared dependencies and peer dependencies, the Nuxt packages
  (`#imports`, `@nuxt/*`, `nuxt`, `h3`, `nitropack`, `vue`) and Node's built-ins stay external.
  A package that ends up inlined without being a dependency fails the build
  (`NUXT_IMPLICIT_DEPENDENCY`); list it in `bundle` to inline it on purpose.
- **Fails on any warning.** Rolldown's, Vite's and the plugins' warnings are errors, except the codes
  in `allowWarnings`. Nothing is written after a failed build.
- **Transpiles the runtime like `mkdist`.** Scripts are compiled with the module's tsconfig (so
  `useDefineForClassFields`, JSX and the like apply), their relative imports get explicit
  extensions, `.vue` files lose their TypeScript and their Sass, Sass files become `.css`
  (`_partials` are skipped), hand-written `.d.ts` files ship as written, and everything else is
  copied. Tests and stories (`*.test.*`, `*.spec.*`, `__tests__`, `*.stories.*`) are left out.
- **Declares the runtime.** Every script and `.vue` file gets a `.d.ts`, emitted in process with
  the module's tsconfig. A declaration TypeScript cannot emit fails the build, and so does an import
  it cannot resolve (it would turn into `any`). `#app` becomes `nuxt/app`, which any resolver finds.
- **Keeps the module and the runtime wired.** A bundled entry importing a runtime file keeps it a
  relative import of the file built per file, in the JS and in the declarations; a runtime file
  importing a bundled entry (`../../shared`) points at that entry's output.
- **Type-checks the module.** The module's sources are checked before its declarations are written,
  and the written declarations are checked again as a consumer reads them.
- **Writes `module.json` and `types.d.mts`.** The module is imported once built to read `getMeta()`.

### The module's tsconfig

A module's tsconfig usually extends `.nuxt/tsconfig.json`, which only `nuxi prepare` writes. The
build never guesses around a missing one: it fails and says to run `nuxi prepare` (the usual
`dev:prepare` script), or you set `prepare: true` and the build runs it first, in a child process, the
way `nuxt-module-build prepare` does. `@nuxt/schema`, where `defineNuxtModule()`'s type comes from,
is mapped for the declaration step through the module's `@nuxt/kit`, as Nuxt's generated tsconfig does.

## Options

`nuxtModule(options)` returns a list of Vite plugins that apply to `vite build`. Every default is a
named constant, exported from the package.

| Option           | Default                                   | Meaning                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `module`         | `src/module.ts` (`NUXT_MODULE_ENTRY`)     | The module file. The build fails when it does not exist.                                                                                                                                                                 |
| `entry`          | none                                      | Further bundled entries (`{ server: "src/server.ts" }`, or a list named after its files). None may lie in `runtimeDir`.                                                                                                  |
| `runtimeDir`     | `src/runtime` (`NUXT_RUNTIME_DIR`)        | The runtime directory, when it exists. `false` for a module without one. A directory given and missing fails the build.                                                                                                  |
| `runtimeExclude` | `[]`                                      | Globs (relative to `runtimeDir`) of files to leave out, on top of tests and stories.                                                                                                                                     |
| `sourceRoot`     | `src` (`SOURCE_ROOT`)                     | The directory holding the sources; its tests are not type-checked.                                                                                                                                                       |
| `extension`      | `.mjs` (`NUXT_EXTENSION`)                 | `.mjs` or `.js` (`.js` only in a `"type": "module"` package). Declarations follow: `.d.mts` or `.d.ts`.                                                                                                                  |
| `tsconfig`       | `tsconfig.lib.json`, else `tsconfig.json` | The tsconfig the module is typed and transpiled with, else the nearest `tsconfig.json` above the project.                                                                                                                |
| `external`       | `[]`                                      | Specifiers to keep external, on top of the dependencies, the Nuxt packages (`NUXT_EXTERNALS`) and the Node built-ins.                                                                                                    |
| `bundle`         | `[]`                                      | Packages to inline on purpose: declared dependencies, or packages that would fail the build as implicitly bundled.                                                                                                       |
| `target`         | `node20` (`NODE_TARGET`)                  | The build target. Vite's `build.target` wins when it is set.                                                                                                                                                             |
| `sourcemap`      | off (`NUXT_SOURCEMAP`)                    | Source maps for the JS and the declarations. Vite's `build.sourcemap` is the fallback.                                                                                                                                   |
| `dts`            | `{}`                                      | `false` writes no declarations. `{ compatible: true }` also writes each entry's `.d.mts` as `.d.ts`. `{ eager: true }` checks the whole program up front, for declarations that reach types through module augmentation. |
| `moduleMeta`     | none                                      | Fields merged into `module.json`, after what `getMeta()` returns.                                                                                                                                                        |
| `prepare`        | `false`                                   | Run `nuxi prepare` first (see above).                                                                                                                                                                                    |
| `allowWarnings`  | `[]`                                      | Warning codes to tolerate (for example `IMPLICIT_DEPENDENCY`, exported as a constant).                                                                                                                                   |

Vite's own settings apply where they are set: `build.outDir` (default `dist`), `build.emptyOutDir`
(default on), `build.minify` (default off), `build.target` and `build.sourcemap`, and `root`.

## Differences from `@nuxt/module-builder`

- It is a Vite plugin, so the module's Vite config is the one place a build is configured, and
  anything else Vite offers (other plugins, `define`, `resolve`) works in it.
- Warnings are errors, as is a package bundled without being a dependency.
- A missing `.nuxt/tsconfig.json` fails with a message instead of building with other options.
- There is no `--stub` mode and no `build.config.ts`. `vite build --watch` rebuilds everything on a change.

## How the build runs

`nuxtModule()` returns seven Vite plugins. They apply to `vite build` only.

1. **`nuxt-module:warnings`** records every warning Vite logs and fails the build on it, once the
   config has resolved and again once the bundle is written. It also carries the build's outcome,
   which the steps below read so that a failed build leaves nothing behind.
2. **`nuxt-module:config`** (`enforce: "pre"`) resolves the options against the project's Vite config
   (`resolveOptions`, in `src/options.ts`), runs `nuxi prepare` when asked, checks the tsconfig chain,
   and returns the Vite config (`buildConfig`, in `src/plugin.ts`): an SSR build with the module and
   the extra entries as library entries, ES output named `<name><extension>`, shared chunks in
   `shared/`, and the externals.
3. **`nuxt-module:runtime-externals`** turns an import of a runtime file into an external with a
   stand-in specifier, and renders it relative to the importing chunk once the chunk is written
   (Rolldown writes a relative external relative to the entries' common directory, not to the chunk).
4. **`nuxt-module:implicit-dependencies`** warns for each package inlined into the bundle that the
   module does not depend on.
5. **`nuxt-module:no-build-paths`** fails the build when an emitted file names the build machine's
   path.
6. **`nuxt-module:runtime`** writes `runtime/` after the bundle (`src/runtime.ts`): each file is
   transpiled, rewritten (`src/specifiers.ts`) or copied, then its declarations are emitted
   (`src/runtime-declarations.ts`).
7. **`nuxt-module:outputs`** writes the bundled declarations (`src/declarations/bundle.ts`, with
   `rolldown-plugin-dts`), `module.json` (`src/module-json.ts`) and `types.d.mts`
   (`src/types-entry.ts`).

Steps 6 and 7 run in `closeBundle`, in plugin order, and only when the build succeeded.

### Where the code is

| Path                                                                    | Concern                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/defaults.ts`                                                       | Every default, as a named constant                                               |
| `src/options.ts`                                                        | The options, their validation and defaults                                       |
| `src/plugin.ts`                                                         | `nuxtModule()` and the Vite config it adds                                       |
| `src/externals.ts`                                                      | What stays external, and `NUXT_EXTERNALS`                                        |
| `src/warnings.ts`                                                       | The warnings-as-errors policy and the steps that run after the bundle            |
| `src/nuxt-tsconfig.ts`                                                  | The tsconfig chain, and the message when `.nuxt/tsconfig.json` is missing        |
| `src/prepare.ts`                                                        | `nuxi prepare` in a child process                                                |
| `src/runtime*.ts`, `src/specifiers.ts`, `src/vue-sfc.ts`, `src/sass.ts` | The per-file runtime                                                             |
| `src/declarations/`                                                     | Bundling the declarations, and checking the sources and the written declarations |
| `src/outputs.ts`                                                        | The steps after the bundle                                                       |
| `src/resolve.ts`                                                        | Loading tools (TypeScript, Sass, `vue-tsc`) from the module being built          |

## Contributing

If you have suggestions for how this plugin could be improved, or
want to report a bug, open an issue - we'd love all and any
contributions.

## License

Apache License 2.0 © 2026 Mridang Agarwalla
