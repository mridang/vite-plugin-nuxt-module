/**
 * Jest runs every test file in its own VM context, with its own `RegExp`. Rolldown's native binding
 * checks values against the main realm's `RegExp`, so a regular expression made inside a test file
 * (Vite hands its built-in module patterns to Rolldown that way) is rejected. Chaining the
 * context's prototype to the main realm's makes that check pass.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Buffer.constructor is the main realm's Function constructor, which this file needs because only that realm's RegExp is accepted, and TypeScript types it as plain Function
const MainFunction = Buffer.constructor as new (
  body: string,
) => () => RegExpConstructor;
const MainRegExp = new MainFunction('return RegExp')();

if (MainRegExp !== RegExp) {
  Object.setPrototypeOf(RegExp.prototype, MainRegExp.prototype);
}

export {};
