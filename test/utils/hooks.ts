/** A synchronous plugin hook as the tests call it: with the plugin context left empty. */
type SyncHook = (...args: unknown[]) => void;

/** An asynchronous plugin hook as the tests call it. */
type AsyncHook = (...args: unknown[]) => Promise<void>;

/**
 * Whether a value is a function a test can call as a synchronous plugin hook.
 * @param value - The value to check.
 * @returns True when the value is a function.
 * @example
 * isSyncHook(plugin.buildStart); // false when the hook is an `{ handler }` object
 */
function isSyncHook(value: unknown): value is SyncHook {
  return typeof value === 'function';
}

/**
 * Whether a value is a function a test can call as an asynchronous plugin hook.
 * @param value - The value to check.
 * @returns True when the value is a function.
 * @example
 * isAsyncHook(plugin.closeBundle); // false when the hook is an `{ handler }` object
 */
function isAsyncHook(value: unknown): value is AsyncHook {
  return typeof value === 'function';
}

/**
 * Picks the function of a plugin hook that may be a function or an `{ handler }` object.
 * @param hook - The hook, as the plugin declares it.
 * @param isFunction - Tells whether a value is a function of the wanted kind.
 * @returns The function of the hook.
 * @throws {TypeError} When the hook is neither a function nor an object with a function `handler`.
 * @example
 * const handler = functionOf(plugin.closeBundle, isAsyncHook);
 */
function functionOf<H>(
  hook: unknown,
  isFunction: (value: unknown) => value is H,
): H {
  if (isFunction(hook)) {
    return hook;
  }
  if (typeof hook === 'object' && hook !== null && 'handler' in hook) {
    const { handler } = hook;
    if (isFunction(handler)) {
      return handler;
    }
  }
  throw new TypeError(
    'the hook is neither a function nor an object with a handler',
  );
}

/**
 * Calls a synchronous plugin hook.
 * @param hook - The hook, as the plugin declares it.
 * @param args - The arguments to call it with.
 * @example
 * call(plugin.buildStart);
 */
export function call(hook: unknown, ...args: unknown[]): void {
  functionOf(hook, isSyncHook).apply({}, args);
}

/**
 * Calls an asynchronous plugin hook.
 * @param hook - The hook, as the plugin declares it.
 * @param args - The arguments to call it with.
 * @returns A promise that settles with the hook.
 * @example
 * await callAsync(plugin.closeBundle);
 */
export async function callAsync(
  hook: unknown,
  ...args: unknown[]
): Promise<void> {
  await functionOf(hook, isAsyncHook).apply({}, args);
}
