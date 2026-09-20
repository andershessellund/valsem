// ---------------------------------------------------------------------------
// Prototype pollution, scoped: the polluted key exists for the body and is
// removed whatever the body does. A key that outlived its test would pollute
// every test after it in the file, and fail them for the wrong reason.
// ---------------------------------------------------------------------------

/** Run `body` with `proto[key] = value` (say `Object.prototype`, `'polluted'`), then remove the key. */
export function withPolluted<T>(proto: object, key: PropertyKey, value: unknown, body: () => T): T {
  const target = proto as Record<PropertyKey, unknown>;
  target[key] = value;
  try {
    return body();
  } finally {
    delete target[key];
  }
}
