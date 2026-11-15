/**
 * One editor theme for light and dark: every color is a CSS variable from `site.css`, so
 * `prefers-color-scheme` switches both. Guest files are colored only by the server's semantic
 * tokens (`.tk-*` in `site.css`); JavaScript, TypeScript, and SQL use the highlight style.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", fontVariantLigatures: "none" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 16px 0 4px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--gutter)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "32px", fontSize: "12px" },
  ".cm-foldGutter": { display: "none" },
  ".cm-gutter-lint": { width: "14px" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "0 0 0 2px" },
  ".cm-lint-marker": { width: "8px", height: "8px" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--selection)", color: "inherit" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
    overflow: "hidden",
  },
  ".cm-tooltip-hover, .cm-tooltip-lint": { maxWidth: "36em" },
  ".cm-lsp-documentation": { padding: "6px 10px", fontSize: "12.5px" },
  ".cm-lsp-documentation code, .cm-lsp-documentation pre": { fontFamily: "var(--mono)", whiteSpace: "pre-wrap" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12.5px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "1em" },
  ".cm-diagnostic": { padding: "6px 10px", borderLeftWidth: "3px", fontSize: "12.5px", whiteSpace: "pre-wrap" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--error)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  ".cm-diagnosticAction": {
    backgroundColor: "var(--accent)",
    color: "var(--on-accent)",
    borderRadius: "5px",
    padding: "2px 8px",
    font: "inherit",
    fontSize: "12px",
    marginLeft: "0",
    marginTop: "6px",
    display: "block",
  },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--error)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warning)", textUnderlineOffset: "3px" },
  ".cm-inlay-hint": { color: "var(--faint)", fontSize: "0.92em", margin: "0 1px" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-dialog input, .cm-textfield": {
    font: "inherit",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    padding: "3px 6px",
  },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--raised)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "5px" },
});

export const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: "var(--tk-keyword)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--tk-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--tk-function)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--tk-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--tk-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--tk-comment)", fontStyle: "italic" },
  { tag: [t.propertyName], color: "var(--tk-property)" },
  { tag: [t.definition(t.variableName)], color: "var(--fg)" },
]));
