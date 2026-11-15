import { fileURLToPath } from "node:url";
import { createConnection } from "vscode-languageserver/node";
import type { ModuleGraphOptions } from "../graph.ts";
import { nodeHost } from "../host-node.ts";
import type { AnyLanguage } from "../language.ts";
import { stubsFor, touchStamp } from "../ts/embed.ts";
import { listen } from "./core.ts";

export { listen, type ListenOptions } from "./core.ts";

/** The language server over stdio, reading unopened files from disk. */
export const serve = (languages: readonly AnyLanguage[], options: Pick<ModuleGraphOptions, "resolve"> = {}): void => {
  listen(createConnection(process.stdin, process.stdout), languages, {
    host: nodeHost,
    ...options,
    // tsgo does not reload types for a file open in the editor; a stamp file tells it to.
    onSnippetsSaved: (uri) => {
      for (const stub of stubsFor(fileURLToPath(uri))) touchStamp(stub);
    },
  });
};

export const serveLanguage = (language: AnyLanguage): void => serve([language]);
