/**
 * The parlance language server for the playground, in a module Web Worker. Every example
 * language is registered; the page sends its files with `parlance/files` and opens them.
 */
import config from "../../parlance.config.ts";
import { serveWorker } from "../../src/lsp/browser.ts";

serveWorker(config.languages);
