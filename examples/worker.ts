/**
 * The example languages' language server in a browser Web Worker. Bundle this file for the
 * browser (`platform: "browser"`, ES module output) and start it with
 * `new Worker(url, { type: "module" })`. `tests/browser.test.ts` bundles and drives it.
 */
import config from "../parlance.config.ts";
import { serveWorker } from "../src/lsp/browser.ts";

serveWorker(config.languages);
