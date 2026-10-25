/**
 * Jest runs every test file in its own VM context, with its own `RegExp`. Rolldown's native binding
 * checks values against the main realm's `RegExp`, so a regular expression made inside a test file
 * (Vite hands its built-in module patterns to Rolldown that way) is rejected. Chaining the
 * context's prototype to the main realm's makes that check pass.
 */
const MainFunction = Buffer.constructor as FunctionConstructor;
const MainRegExp = new MainFunction('return RegExp')() as RegExpConstructor;

if (MainRegExp !== RegExp) {
  Object.setPrototypeOf(RegExp.prototype, MainRegExp.prototype);
}

export {};
