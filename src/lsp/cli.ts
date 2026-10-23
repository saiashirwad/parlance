import { resolve } from "node:path";
import { discoverConfig, loadLanguages } from "../config.ts";
import { serve } from "./server.ts";

const args = process.argv.slice(2);
const flag = args.indexOf("--config");
const requested = flag >= 0 ? args[flag + 1] : args[0];
const path = requested ? resolve(requested) : discoverConfig(process.cwd());

if (!path) {
  console.error("No parlance config. Pass --config ./parlance.config.ts.");
  process.exit(1);
}

try {
  const languages = await loadLanguages(path);
  if (languages.length === 0) {
    console.error(`${path} exports no languages.`);
    process.exit(1);
  }
  serve(languages);
} catch (cause) {
  console.error(`Cannot load ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
