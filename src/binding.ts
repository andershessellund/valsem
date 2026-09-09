// ---------------------------------------------------------------------------
// valsem/binding — the stable contract for binding authors.
//
// A *binding* is a package that maps valsem's information model onto some
// other representation — a wire format, a storage layer, a schema system.
// Bindings need a few pieces of valsem's machinery that application code
// never should:
//
// - `mutableBuiltinReason` — the mutable-built-in rejection table, so a
//   binding's encode errors tell the same story `deepHash` and `intern` do.
// - `defineRecordField` — the `__proto__`-safe record-field writer, for
//   building records from untrusted keys (e.g. decoded wire data).
//
// There is deliberately no "is this type a value" probe: valsem decides that
// per INSTANCE, at `intern`/`deepHash`, because only the instance can answer
// (a `[hashCode]` may be an instance field) and no probe can verify the
// promise that matters, immutability. A binding learns the same thing the
// same way — `intern` either returns the canonical instance or throws,
// naming what the class lacks.
//
// Unlike the pre-split `valsem/internal` subpath, this surface is covered by
// semver: additions are minor, removals are major. It is still not for
// application code — if you are not writing a binding, you do not need it.
// ---------------------------------------------------------------------------

export {
  _defineRecordField as defineRecordField,
  _mutableBuiltinReason as mutableBuiltinReason,
} from './deep-equal.js';
