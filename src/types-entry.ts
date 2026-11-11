import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'vite';

import { exists } from './exists.js';
import { namesFile } from './package-json.js';

const { join } = path;

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
  const names = new Set<string>();
  const reexports: Reexport[] = [];
  for (const node of statements as readonly Statement[]) {
    if (node.type === 'ExportNamedDeclaration') {
      const id =
        node.declaration?.id?.name ??
        node.declaration?.declarations?.[0]?.id?.name;
      if (id) {
        names.add(id);
        reexports.push({ names: [id], star: false });
      }
      for (const s of node.specifiers ?? []) {
        const exported = s.exported.name ?? s.exported.value ?? '';
        names.add(exported);
        reexports.push({
          names: [exported],
          star: false,
          ...(node.source ? { specifier: node.source.value } : {}),
        });
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      names.add('default');
      reexports.push({ names: ['default'], star: false });
    } else if (node.type === 'ExportAllDeclaration' && node.source) {
      reexports.push({ names: [], star: true, specifier: node.source.value });
    } else {
      // Other statements add no export name for the scan to record.
    }
  }
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
  const schemaImports: string[] = [];
  const moduleImports: string[] = [];
  const appShims: string[] = [];
  const schemaShims: string[] = [];
  const moduleExports: string[] = [];
  if (!names.has('ModuleOptions')) {
    schemaImports.push('NuxtModule');
    moduleImports.push('default as Module');
    moduleExports.push(
      'export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>',
    );
  }
  for (const hook of HOOKS) {
    if (!names.has(hook.name)) continue;
    moduleImports.push(hook.name);
    (hook.module === '#app' ? appShims : schemaShims).push(hook.shim);
  }
  const named = reexports
    .filter((e) => !e.star)
    .map(
      (e) =>
        `\nexport { ${e.names.map((n) => (n === 'default' ? '' : 'type ') + n).join(', ')} } from '${e.specifier ?? moduleFile}'`,
    );
  const stars = reexports
    .filter((e) => e.star)
    .map((e) => `\nexport * from '${e.specifier ?? moduleFile}'`);
  const text = `
  ${schemaImports.length > 0 ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

${moduleImports.length > 0 ? `import type { ${moduleImports.join(', ')} } from '${moduleFile}'` : ''}

${appShims.length > 0 ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length > 0 ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length > 0 ? `\n${moduleExports.join('\n')}` : ''}
${named.join('')}
${stars.join('')}
`;
  return `${text.trim().replaceAll(/[\n\r]{3,}/g, '\n\n')}\n`;
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
  const file = join(outDir, mjs ? 'types.d.mts' : 'types.d.ts');
  if ((await exists(file)) || !(await namesFile(root, file))) return;
  const declaration = await readFile(
    join(outDir, mjs ? 'module.d.mts' : 'module.d.ts'),
    'utf8',
  );
  await writeFile(file, await typesEntry(declaration, `./module${extension}`));
}
