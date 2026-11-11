import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The `package.json` fields this package reads. */
export interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly type?: string;
  readonly exports?: unknown;
  readonly sideEffects?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

/** The `package.json` of the package at `root`. */
export async function readPackageJson(root: string): Promise<PackageJson> {
  return JSON.parse(
    await readFile(path.resolve(root, 'package.json'), 'utf8'),
  ) as PackageJson;
}

/** Whether the package at `root` is an ES module package (`"type": "module"`). */
export async function isModulePackage(root: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  return pkg.type === 'module';
}

/** The manifest fields that name a file consumers load: entry points and type entry points. */
const PUBLISHED_FIELDS = [
  'exports',
  'main',
  'module',
  'types',
  'typings',
  'typesVersions',
] as const;

/** Every string a JSON value holds, nested ones included. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => strings(item));
  if (value && typeof value === 'object')
    return Object.values(value).flatMap((item) => strings(item));
  return [];
}

/**
 * Whether the manifest of the package at `root` names `file` (absolute) as something consumers
 * load: an `exports` target, `main`, `module`, `types`, `typings` or a `typesVersions` target. A
 * file it names nowhere is unreachable once published.
 */
export async function namesFile(root: string, file: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  return PUBLISHED_FIELDS.flatMap((field) => strings(pkg[field])).some(
    (target) => path.resolve(root, target) === path.resolve(file),
  );
}
