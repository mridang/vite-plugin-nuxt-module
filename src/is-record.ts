/**
 * Whether a value is a non-null object, so its properties can be read by name.
 * @param value - The value to check.
 * @returns True when the value is a non-null object.
 * @example
 * isRecord({ exports: {} }); // true
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
