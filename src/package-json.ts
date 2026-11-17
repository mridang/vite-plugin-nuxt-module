import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './is-record.js';

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

/** The value of a field that must be a string, or undefined when it is anything else. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The value of a field that must map names to strings (the dependency lists), or undefined when it does not. */
function stringMapField(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length === Object.keys(value).length
    ? Object.fromEntries(entries)
    : undefined;
}

/**
 * Parses the text of a `package.json`: the fields this package reads keep their value only when it
 * has the type the field is declared with.
 * @param text - The JSON text of the manifest.
 * @returns The manifest.
 * @throws {TypeError} When the text is not a JSON object.
 */
export function parsePackageJson(text: string): PackageJson {
  const json: unknown = JSON.parse(text);
  if (!isRecord(json)) {
    throw new TypeError('a package.json must hold a JSON object');
  }
  return {
    ...json,
    name: stringField(json.name),
    version: stringField(json.version),
    type: stringField(json.type),
    dependencies: stringMapField(json.dependencies),
    devDependencies: stringMapField(json.devDependencies),
    peerDependencies: stringMapField(json.peerDependencies),
    optionalDependencies: stringMapField(json.optionalDependencies),
  };
}

/** The `package.json` of the package at `root`. */
export async function readPackageJson(root: string): Promise<PackageJson> {
  return parsePackageJson(
    await readFile(path.resolve(root, 'package.json'), 'utf8'),
  );
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
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => strings(item));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => strings(item));
  }
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
