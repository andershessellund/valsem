// ---------------------------------------------------------------------------
// A Temporal global for the suites that need one, on every supported Node.
//
// Native Temporal where the runtime has it (the `latest` CI leg); elsewhere
// `temporal-polyfill`, a dev dependency, installed as the global — which is
// the documented route for a consumer on such a runtime too ("install a
// polyfill before importing this module"). So the Temporal suites run on
// the Node floor instead of skipping themselves there, and the polyfill
// route is tested rather than only described.
//
// Import this BEFORE `./temporal.js`: that module reads the global when it
// is evaluated. A static import of this file ahead of a dynamic
// `await import('./temporal.js')` gives that order.
// ---------------------------------------------------------------------------

const g = globalThis as { Temporal?: unknown };

/** Whether the runtime brought its own Temporal (false: the polyfill stands in). */
export const NATIVE_TEMPORAL = typeof g.Temporal !== 'undefined';

// The `/full` build, since the default one knows only the ISO and Gregorian
// calendars and the suite compares across others. Its index, not its
// `/global` entry: that one also declares the global's TYPES, which would
// leak into the library's own type program.
if (!NATIVE_TEMPORAL) g.Temporal = (await import('temporal-polyfill/full')).Temporal;

// Neither Node's Temporal nor the tests' `lib` has types for it; the tests
// talk to it untyped.
export const Temporal = g.Temporal as any;
