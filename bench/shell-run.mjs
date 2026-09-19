// Run ONE suite inside an engine shell and print its rows as JSON:
//   js -m bench/shell-run.mjs frozen-array
// Only suites built on timing.mjs alone can run here (no Node imports, no
// comparison libraries from node_modules). Driven by run-spidermonkey.mjs.
import { args } from './shell-compat.mjs';

const suite = (await import(`./suites/${args[0]}.mjs`)).default;
console.log(JSON.stringify(await suite.rows()));
