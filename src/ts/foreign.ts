import type { Binding, ForeignModule } from "../check/index.ts";
import { isBareSpecifier } from "../language.ts";
import { join, source, ts, type TsDoc, type TsValue } from "./template.ts";

/** The specifier between quotes, mapped to the guest span when the text is unchanged. */
const quoted = (text: string, span: { readonly start: number; readonly end: number }): TsValue =>
  text.length === span.end - span.start && !/["\\\n]/.test(text) ? ts`"${source(text, span)}"` : JSON.stringify(text);

/**
 * `import { a, b } from "spec";` for the TypeScript surface, one line per foreign import. Names and
 * the specifier are mapped to their guest spans, so tsgo reports a missing export, hover, and
 * definition at the guest text and navigates into the TypeScript file.
 */
export const foreignImports = (modules: readonly ForeignModule[]): TsDoc =>
  join(
    modules.flatMap((module) =>
      module.names.length === 0
        ? []
        : [ts`import { ${join(module.names.map((entry) => source(entry.name, entry.span)), ", ")} } from ${
          quoted(module.specifier, module.span)
        };
`]
    ),
  );

/**
 * The same imports for the emitted runtime module. `local` names each binding in the output, so the
 * guest name cannot collide with generated code. A bare specifier is emitted as its resolved file URL,
 * so the runtime loads what the checker saw; relative specifiers resolve from the guest file as written.
 */
export const foreignRuntime = <T>(modules: readonly ForeignModule<T>[], local: (binding: Binding<T>) => string): TsDoc =>
  join(
    modules.flatMap((module) =>
      module.names.length === 0
        ? []
        : [ts`import { ${
          join(module.names.map((entry, index) => ts`${source(entry.name, entry.span)} as ${local(module.bindings[index]!)}`), ", ")
        } } from ${
          isBareSpecifier(module.specifier) && module.uri?.startsWith("file:")
            ? JSON.stringify(module.uri)
            : quoted(module.specifier, module.span)
        };
`]
    ),
  );
