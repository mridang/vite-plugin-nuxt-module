export {
  IMPLICIT_DEPENDENCY,
  MODULE_JSON,
  NODE_TARGET,
  NUXT_EXTENSION,
  NUXT_EXTENSIONS,
  NUXT_EXTERNALS,
  NUXT_MODULE_ENTRY,
  NUXT_RUNTIME_DIR,
  NUXT_SOURCEMAP,
  OUT_DIR,
  SOURCE_ROOT,
} from './defaults.js';
export type { EntryOption } from './entries.js';
export type { Matcher } from './externals.js';
export type { NuxtModuleOptions } from './options.js';
export { nuxtModule, nuxtModule as default } from './plugin.js';
