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
// - `hasValueSemantics` — the registration probe, for guards that require a
//   type to have equality/hash handlers before accepting a codec for it.
//
// Unlike the pre-split `valsem/internal` subpath, this surface is covered by
// semver: additions are minor, removals are major. It is still not for
// application code — if you are not writing a binding, you do not need it.
// ---------------------------------------------------------------------------

export {
  _defineRecordField as defineRecordField,
  _hasValueSemantics as hasValueSemantics,
  _mutableBuiltinReason as mutableBuiltinReason,
} from './deep-equal.js';
