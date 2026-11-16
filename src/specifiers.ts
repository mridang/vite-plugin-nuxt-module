import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'vite';

const TS_JSX_EXTENSION_PATTERN = /\.(ts|tsx|jsx)$/;
const MTS_EXTENSION_PATTERN = /\.mts$/;
const CTS_EXTENSION_PATTERN = /\.cts$/;
const JS_EXTENSION_PATTERN = /\.[cm]?js$/;
const RELATIVE_OR_ROOT_SPECIFIER_PATTERN = /^\.\.?(\/|$)/;
const QUERY_OR_HASH_CHARACTER_PATTERN = /[?#]/;
const TS_SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|jsx|mts|cts)$/;
const QUOTE_OR_BACKSLASH_PATTERN = /['"\\]/;

/** A declaration file name. */
export const DECLARATION_RE = /\.d\.[cm]?ts$/;

/** Source extensions a relative specifier may leave out, in resolution order. */
const SOURCE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
];

/** A Sass stylesheet, compiled to `.css` in the runtime output. */
export const SASS_RE = /\.s[ac]ss$/;

/** A Sass partial (`_vars.scss`): only ever `@use`d, never compiled or shipped on its own. */
export const isSassPartial = (file: string): boolean =>
  SASS_RE.test(file) && path.basename(file).startsWith('_');

/**
 * Where a runtime source file lands in `outDir/runtime` (`.ts` → `.js`, Sass → `.css`, `.vue` and other assets keep
 * their name).
 */
export function runtimeOutName(file: string): string {
  if (DECLARATION_RE.test(file)) return file;
  return file
    .replace(TS_JSX_EXTENSION_PATTERN, '.js')
    .replace(MTS_EXTENSION_PATTERN, '.mjs')
    .replace(CTS_EXTENSION_PATTERN, '.cjs')
    .replace(SASS_RE, '.css');
}

/**
 * Where the per-file runtime sits relative to the bundled entries. A runtime file may import a source file outside
 * the runtime dir that is itself a bundled entry (`../../utils/headers` → `src/utils/headers.ts`, built as
 * `utils/headers.mjs`): that import must point at the entry's output, not at a per-file `.js` that never exists.
 */
export interface SpecifierScope {
  readonly runtimeDir: string;
  /** Absolute entry source file → its output path relative to `outDir` (`utils/headers.mjs`). */
  readonly entries: Readonly<Record<string, string>>;
}

const isFile = async (p: string): Promise<boolean> =>
  stat(p)
    .then((info) => info.isFile())
    .catch(() => false);

/** The first of `files` that is a file, in order. */
async function firstFile(
  files: readonly string[],
): Promise<string | undefined> {
  const found = await Promise.all(files.map(async (file) => isFile(file)));
  return files.find((_, index) => found[index]);
}

/** TypeScript extensions a `.js` specifier can stand for (TS NodeNext style: `./x.js` for `x.ts`). */
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * The source file a relative import resolved to `target` names, the way TypeScript's bundler
 * resolution finds it: the file as written, its TypeScript source when written as `.js`, else with
 * each source extension, else as a directory's index.
 */
export async function sourceFileOf(
  target: string,
): Promise<string | undefined> {
  if (await isFile(target)) return target;
  if (JS_EXTENSION_PATTERN.test(target)) {
    const found = await firstFile(
      TS_EXTS.map((ts) => target.replace(JS_EXTENSION_PATTERN, ts)),
    );
    if (found) return found;
  }
  return (
    (await firstFile(SOURCE_EXTS.map((extension) => target + extension))) ??
    (await firstFile(
      SOURCE_EXTS.map((extension) => path.join(target, `index${extension}`)),
    ))
  );
}

/**
 * Resolves a relative specifier the way TypeScript's bundler resolution does, against `runtimeDir` (the source
 * tree), and returns the specifier as it must read in the built tree: explicit extension, `.vue` kept, `.ts` → `.js`,
 * a directory → `dir/index.js`. With a `scope`, a target outside the runtime dir is rewritten only when it is a
 * bundled entry (to that entry's output); anything else outside is left untouched. Specifiers that are not relative
 * or do not resolve are returned untouched.
 */
export async function rewriteSpecifier(
  spec: string,
  fromFile: string,
  scope?: SpecifierScope,
): Promise<string> {
  if (!RELATIVE_OR_ROOT_SPECIFIER_PATTERN.test(spec)) return spec;
  const queryAt = spec.search(QUERY_OR_HASH_CHARACTER_PATTERN);
  const suffix = queryAt < 0 ? '' : spec.slice(queryAt);
  const bare = suffix ? spec.slice(0, -suffix.length) : spec;
  const target = path.resolve(path.dirname(fromFile), bare);
  const specifierOf = (relativePath: string): string =>
    (relativePath.startsWith('.') ? relativePath : `./${relativePath}`) +
    suffix;
  const inside = (p: string) =>
    !scope || p.startsWith(scope.runtimeDir + path.sep);
  const located = (p: string): string => {
    if (!scope || inside(p))
      return specifierOf(
        path
          .relative(path.dirname(fromFile), runtimeOutName(p))
          .split(path.sep)
          .join('/'),
      );
    const entry = scope.entries[p];
    if (!entry) return spec;
    // `fromFile` lands at `outDir/runtime/<rel>`, the entry at `outDir/<entry>`.
    const fromOut = path.posix.join(
      '/out/runtime',
      path
        .relative(scope.runtimeDir, path.dirname(fromFile))
        .split(path.sep)
        .join('/'),
    );
    return specifierOf(
      path.posix.relative(fromOut, path.posix.join('/out', entry)),
    );
  };
  // `./x.js` written for `x.ts` (TS NodeNext style), or `./x.ts` itself.
  const explicit = path.extname(bare);
  if (explicit && (await isFile(target))) {
    // A Sass import names the stylesheet the runtime build compiles it to (`./theme.scss` → `./theme.css`).
    const isSourceImport =
      TS_SOURCE_EXTENSION_PATTERN.test(explicit) && !DECLARATION_RE.test(bare);
    const isSassImport =
      SASS_RE.test(explicit) && inside(target) && !isSassPartial(target);
    return isSourceImport || isSassImport ? located(target) : spec;
  }
  const source = await sourceFileOf(target);
  if (!source) return spec;
  // `./x.js` written for a runtime `x.ts` already names the file built per file.
  if (JS_EXTENSION_PATTERN.test(explicit) && inside(source)) return spec;
  return located(source);
}

/** An ESTree node, as far as the specifier walk reads it. */
interface AstNode {
  readonly type?: string;
  readonly start?: number;
  readonly end?: number;
  readonly source?: AstNode | null;
  readonly value?: unknown;
}

/** Node types whose `source` is a module specifier: imports, re-exports, `import()` and `import("x").T` types. */
const IMPORTING_NODES = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
  'ImportExpression',
  'TSImportType',
]);

/** One replacement of a source range. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** How a specifier is written in the source text: the quote it had is kept. */
function quoted(original: string, specifier: string): string {
  const quote = original.slice(0, 1);
  return (quote === "'" || quote === '"') &&
    !QUOTE_OR_BACKSLASH_PATTERN.test(specifier)
    ? `${quote}${specifier}${quote}`
    : JSON.stringify(specifier);
}

/**
 * The edits that rewrite the module specifiers of `code` (a JS module, or a declaration with `lang: "dts"`):
 * every static and dynamic import, re-export and import type. `map` returns the new specifier, or nothing to leave
 * it. Found with the parser, never by pattern.
 */
export async function specifierEdits(
  code: string,
  lang: 'js' | 'dts',
  map: (specifier: string) => string | undefined | Promise<string | undefined>,
): Promise<Edit[]> {
  const { program } = await parse('module.ts', code, { lang });
  const found: { start: number; end: number; value: string }[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as AstNode;
    const src =
      node.type && IMPORTING_NODES.has(node.type) && node.source
        ? node.source
        : undefined;
    if (
      src &&
      typeof src.value === 'string' &&
      src.start !== undefined &&
      src.end !== undefined
    ) {
      found.push({ start: src.start, end: src.end, value: src.value });
    }
    for (const [key, child] of Object.entries(node))
      if (key !== 'source' || !src) visit(child);
  };
  visit(program.body);
  const mapped = await Promise.all(found.map(async (item) => map(item.value)));
  return found.flatMap((item, index) => {
    const next = mapped[index];
    return next !== undefined && next !== item.value
      ? [
          {
            start: item.start,
            end: item.end,
            text: quoted(code.slice(item.start, item.end), next),
          },
        ]
      : [];
  });
}

/** `code` with `edits` applied. */
export function applyEdits(code: string, edits: readonly Edit[]): string {
  return [...edits]
    .toSorted((a, b) => b.start - a.start)
    .reduce(
      (c, edit) => c.slice(0, edit.start) + edit.text + c.slice(edit.end),
      code,
    );
}

/** Rewrites every static / dynamic import and re-export specifier of a transpiled JS module. */
export async function rewriteImports(
  code: string,
  fromFile: string,
  scope?: SpecifierScope,
): Promise<string> {
  return applyEdits(
    code,
    await specifierEdits(code, 'js', async (spec) =>
      rewriteSpecifier(spec, fromFile, scope),
    ),
  );
}

/** Same for a declaration: `from "./x"`, `import("./x")`, `import "./x"`. */
export async function rewriteDeclarationImports(
  code: string,
  fromFile: string,
  scope?: SpecifierScope,
): Promise<string> {
  return applyEdits(
    code,
    await specifierEdits(code, 'dts', async (spec) =>
      rewriteSpecifier(spec, fromFile, scope),
    ),
  );
}
