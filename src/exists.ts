import { access } from 'node:fs/promises';

/** Whether a path exists. */
export const exists = (file: string): Promise<boolean> =>
  access(file)
    .then(() => true)
    .catch(() => false);
