import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package directory: Nuxt, `@nuxt/kit` and the rest of the tools resolve from its `node_modules`. */
export const PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
);

/** The fixture module (a Nuxt module's package) and the Nuxt app that installs it. */
export const FIXTURES = path.join(PACKAGE_ROOT, 'test/contract/fixtures');
