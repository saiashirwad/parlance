/**
 * A `.parl` file's text as a TypeScript module. A language imports it instead of reading the
 * grammar from disk, so it loads the same way in Node and in a browser bundle.
 * `tools/grammar-check.ts` fails when a checked-in module no longer matches its grammar.
 */
export const grammarSourceModule = (source: string, name: string): string => {
  const body = source.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${").replaceAll("\r", "\\r");
  return `// Generated from ${name} by \`parlance source\`. Do not edit.\nexport default \`${body}\`;\n`;
};
