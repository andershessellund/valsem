// ---------------------------------------------------------------------------
// What an engine shell (SpiderMonkey's `js`) lacks and the measured code or a
// worker needs. Import this FIRST: valsem draws its hash seed from Web Crypto
// when its hasher module is evaluated.
//
// None of it touches what is measured. The shell has no Web Crypto (Firefox
// does; valsem needs it once, at import), prints with `print`, and passes
// arguments in `scriptArgs`.
// ---------------------------------------------------------------------------
if (globalThis.crypto === undefined) {
  globalThis.crypto = {
    getRandomValues(array) {
      for (let i = 0; i < array.length; i++) array[i] = (Math.random() * 2 ** 32) >>> 0;
      return array;
    },
  };
}
if (globalThis.console === undefined) globalThis.console = { log: (...a) => globalThis.print(a.join(' ')) };

/** The arguments after the script's name, in Node, Bun or a shell. */
export const args = globalThis.scriptArgs ?? globalThis.process?.argv?.slice(2) ?? [];
