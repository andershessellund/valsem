// ---------------------------------------------------------------------------
// limits — decode-boundary guards
//
// `intern` and `deepHash` walk foreign input recursively, so hostile (or
// cyclic) input has a stack-exhaustion lever the seeded hasher does not
// close. A depth cap turns that failure mode into a teaching error at the
// admission boundary. `deepEqual` is deliberately NOT capped: capping would
// change verdicts on honestly deep equal structures. It is total over
// ADMITTED values (nothing deeper than the cap gets through intern/deepHash),
// and it never throws on a type or a mutable built-in — but on raw, never-
// admitted input it is an ordinary recursive walk: cyclic input, or nesting
// deeper than the engine's stack, overflows the stack.
//
// The default (512) is far beyond honest data (typical trees are < 100
// deep) and far below engine stack limits for these walks. Unlike the
// hasher, the cap is not baked into values — it may be reconfigured at any
// time.
// ---------------------------------------------------------------------------

let maxDepth = 512;

/**
 * Configure decode-boundary limits.
 *
 * @param limits.maxDepth - Maximum nesting depth `intern`/`deepHash` will
 * walk before rejecting the input (default 512). Must be a positive
 * integer. May be changed at any time.
 */
export function configureLimits(limits: { maxDepth?: number }): void {
  if (limits.maxDepth !== undefined) {
    if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 1) {
      throw new RangeError('valsem: configureLimits maxDepth must be a positive integer');
    }
    maxDepth = limits.maxDepth;
  }
}

/** @internal Current depth cap. */
export function _maxDepth(): number {
  return maxDepth;
}

/** @internal Teaching error for a depth-cap hit; resets belong to the caller. */
export function _depthError(fn: string): RangeError {
  return new RangeError(
    `valsem: ${fn} exceeded the maximum nesting depth (${maxDepth}). Deeply nested or ` +
      `cyclic input cannot be admitted as a value; if this is honest data, raise the ` +
      `cap with configureLimits({ maxDepth }).`,
  );
}
