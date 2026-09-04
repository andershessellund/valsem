// ---------------------------------------------------------------------------
// valsem/internal — internals exposed for first-party bindings.
//
// The samme wire package (valsem's serialization binding) needs a few pieces
// of valsem's machinery that are not part of the public value-semantics API:
// the mutable-built-in rejection table (so encode errors tell the same story
// deepHash and intern do), the __proto__-safe record-field writer, and the
// value-semantics probe behind samme's registration guard.
//
// Everything here is UNSTABLE: no semver promises, may change or vanish in any
// release. Application code should never import this subpath.
// ---------------------------------------------------------------------------

export { _defineRecordField, _hasValueSemantics, _mutableBuiltinReason } from './deep-equal.js';
