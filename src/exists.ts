import { access } from 'node:fs/promises';

/** Whether a path exists. */
export const exists = (file: string): Promise<boolean> =>
  access(file)
    .then(() => true)
    .catch(() => false);

/**
 * The first result of `check` over `items`, in order, running each only when the ones before it
 * found nothing.
 */
export const firstFound = <T, R>(
  items: readonly T[],
  check: (item: T) => Promise<R | undefined>,
): Promise<R | undefined> =>
  items.reduce<Promise<R | undefined>>(
    async (previous, item) => (await previous) ?? check(item),
    Promise.resolve(undefined),
  );
