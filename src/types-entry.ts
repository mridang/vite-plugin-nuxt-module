import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'vite';

import { exists } from './exists.js';
import { namesFile } from './package-json.js';

/** An identifier or string literal naming an export. */
interface ExportName {
  readonly name?: string;
  readonly value?: string;
}

/** A top-level statement of the module declaration, as far as the export scan reads it. */
interface Statement {
  readonly type: string;
  readonly declaration?: {
    readonly id?: { readonly name?: string } | null;
    readonly declarations?: readonly {
      readonly id?: { readonly name?: string };
    }[];
  } | null;
  readonly specifiers?: readonly { readonly exported: ExportName }[];
  readonly source?: { readonly value: string } | null;
}

interface Reexport {
  readonly names: string[];
  readonly star: boolean;
  readonly specifier?: string;
}

/** The module declaration's exports: every name, and each export statement to re-export. */
async function scanExports(declaration: string): Promise<{
  names: Set<string>;
  reexports: Reexport[];
}> {
  const { program } = await parse('module.ts', declaration, { lang: 'ts' });
  const statements: unknown = program.body;
  const reexports = (Array.isArray(statements) ? statements : []).flatMap(
    (node: Statement): Reexport[] => {
      if (node.type === 'ExportNamedDeclaration') {
        const id =
          node.declaration?.id?.name ??
          node.declaration?.declarations?.[0]?.id?.name;
        return [
          ...(id ? [{ names: [id], star: false }] : []),
          ...(node.specifiers ?? []).map((s) => ({
            names: [s.exported.name ?? s.exported.value ?? ''],
            star: false,
            ...(node.source ? { specifier: node.source.value } : {}),
          })),
        ];
      }
      if (node.type === 'ExportDefaultDeclaration') {
        return [{ names: ['default'], star: false }];
      }
      if (node.type === 'ExportAllDeclaration' && node.source) {
        return [{ names: [], star: true, specifier: node.source.value }];
      }
      // Other statements add no export name for the scan to record.
      return [];
    },
  );
  const names = new Set(reexports.flatMap((reexport) => reexport.names));
  return { names, reexports };
}

/** Module exports that extend a Nuxt interface, and where that interface is declared. */
const HOOKS: readonly {
  readonly name: string;
  readonly module: '#app' | '@nuxt/schema';
  readonly shim: string;
}[] = [
  {
    name: 'ModuleHooks',
    module: '@nuxt/schema',
    shim: '  interface NuxtHooks extends ModuleHooks {}',
  },
  {
    name: 'ModuleRuntimeHooks',
    module: '#app',
    shim: '  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}',
  },
  {
    name: 'ModuleRuntimeConfig',
    module: '@nuxt/schema',
    shim: '  interface RuntimeConfig extends ModuleRuntimeConfig {}',
  },
  {
    name: 'ModulePublicRuntimeConfig',
    module: '@nuxt/schema',
    shim: '  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}',
  },
];

/**
 * The `types` declaration `@nuxt/module-builder` writes for a module whose declaration is
 * `declaration` and whose entry is `moduleFile` (`./module.mjs`): the module's public types plus
 * `#app` / `@nuxt/schema` hooks and runtime config shims.
 */
export async function typesEntry(
  declaration: string,
  moduleFile: string,
): Promise<string> {
  const { names, reexports } = await scanExports(declaration);
  const declaresOptions = names.has('ModuleOptions');
  const hooks = HOOKS.filter((hook) => names.has(hook.name));
  const schemaImports = declaresOptions ? [] : ['NuxtModule'];
  const moduleImports = [
    ...(declaresOptions ? [] : ['default as Module']),
    ...hooks.map((hook) => hook.name),
  ];
  const appShims = hooks.flatMap((hook) =>
    hook.module === '#app' ? [hook.shim] : [],
  );
  const schemaShims = hooks.flatMap((hook) =>
    hook.module === '#app' ? [] : [hook.shim],
  );
  const moduleExports = declaresOptions
    ? []
    : [
        'export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>',
      ];
  const named = reexports
    .filter((reexport) => !reexport.star)
    .map(
      (reexport) =>
        `\nexport { ${reexport.names.map((n) => (n === 'default' ? '' : 'type ') + n).join(', ')} } from '${reexport.specifier ?? moduleFile}'`,
    );
  const stars = reexports
    .filter((reexport) => reexport.star)
    .map((reexport) => `\nexport * from '${reexport.specifier ?? moduleFile}'`);
  const text = `
  ${schemaImports.length > 0 ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

${moduleImports.length > 0 ? `import type { ${moduleImports.join(', ')} } from '${moduleFile}'` : ''}

${appShims.length > 0 ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length > 0 ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length > 0 ? `\n${moduleExports.join('\n')}` : ''}
${named.join('')}
${stars.join('')}
`;
  return `${text.trim().replaceAll(/[\n\r]{3,}/gu, '\n\n')}\n`;
}

/**
 * Writes `types.d.mts` (`types.d.ts` for a `.js` build) next to the module, when the manifest of the
 * package at `root` names it (see `namesFile`) and the module does not ship its own.
 */
export async function writeTypesEntry(
  root: string,
  outDir: string,
  extension: string,
): Promise<void> {
  const mjs = extension === '.mjs';
  // Paired with the module's own declaration extension: `module.mjs` → `types.d.mts`, `module.js` → `types.d.ts`.
  const file = path.join(outDir, mjs ? 'types.d.mts' : 'types.d.ts');
  if ((await exists(file)) || !(await namesFile(root, file))) {
    return;
  }
  const declaration = await readFile(
    path.join(outDir, mjs ? 'module.d.mts' : 'module.d.ts'),
    'utf8',
  );
  await writeFile(file, await typesEntry(declaration, `./module${extension}`));
}
