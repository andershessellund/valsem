// ---------------------------------------------------------------------------
// Setup file for the POLLUTED test run (`pnpm test:polluted`): the ordinary
// suite, with every index a small array could have a hole at defined on
// Array.prototype.
//
// An array hole is not `undefined`: `arr[i]` on a hole reads the prototype
// chain, and so do `slice`, spread, `Array.from`, `concat` and the array
// iterator. With this in place, any code that reads a hole — in a caller's
// sparse array, or in one of valsem's own (`new Array(n)` read before it is
// written, an out-of-range index) — gets this sentinel instead, and the test
// that depended on `undefined` fails. The first run of this found four such
// reads inside the library that no targeted test had.
//
// A frozen OBJECT, not a string: an object is what reaches canonical state
// through produce's graft path, where a primitive happens not to.
// ---------------------------------------------------------------------------
export const POLLUTED = Object.freeze({ POLLUTED: true });

for (let i = 0; i < 64; i++) {
  Object.defineProperty(Array.prototype, i, {
    value: POLLUTED,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
