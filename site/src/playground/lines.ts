/**
 * Linked lines, as on GitHub: the lines a URL names get a quiet highlight, and the line-number
 * gutter picks them (click a line, shift-click to extend; right-click copies the link).
 */
import { type EditorState, type Extension, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutterLineClass, lineNumbers } from "@codemirror/view";
import type { Position } from "./share.ts";

/** Lines from `from` to `to` (document offsets), or none. */
type Linked = { readonly from: number; readonly to: number } | null;

const setLinked = StateEffect.define<Linked>();

const linkedField = StateField.define<Linked>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setLinked)) return effect.value;
    return value && transaction.docChanged
      ? { from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to) }
      : value;
  },
});

const lineMark = Decoration.line({ class: "cm-linked" });
const gutterMark = new class extends GutterMarker {
  override elementClass = "cm-linked-gutter";
}();

const marks = (state: EditorState): { lines: DecorationSet; gutter: RangeSet<GutterMarker> } => {
  const linked = state.field(linkedField);
  if (!linked) return { lines: Decoration.none, gutter: RangeSet.empty };
  const doc = state.doc;
  const starts: number[] = [];
  for (let line = doc.lineAt(linked.from).number; line <= doc.lineAt(linked.to).number; line++) starts.push(doc.line(line).from);
  return {
    lines: Decoration.set(starts.map((from) => lineMark.range(from))),
    gutter: RangeSet.of(starts.map((from) => gutterMark.range(from))),
  };
};

export type LineHooks = {
  /** A line number was clicked; `extend` with shift held. */
  readonly pick: (line: number, extend: boolean) => void;
  /** A line number was right-clicked. */
  readonly copy: (line: number) => void;
};

export const linkedLines = (hooks: LineHooks): Extension => [
  linkedField,
  EditorView.decorations.compute([linkedField], (state) => marks(state).lines),
  gutterLineClass.compute([linkedField], (state) => marks(state).gutter),
  lineNumbers({
    domEventHandlers: {
      mousedown: (view, block, event) => {
        if ((event as MouseEvent).button !== 0) return false;
        hooks.pick(view.state.doc.lineAt(block.from).number, (event as MouseEvent).shiftKey);
        event.preventDefault();
        return true;
      },
      contextmenu: (view, block, event) => {
        hooks.copy(view.state.doc.lineAt(block.from).number);
        event.preventDefault();
        return true;
      },
    },
  }),
];

/** Highlights a position's lines (or nothing) and, with `reveal`, scrolls them into view. */
export const showLinked = (view: EditorView, position: Position | null, reveal = false): void => {
  if (!position) return view.dispatch({ effects: setLinked.of(null) });
  const doc = view.state.doc;
  const start = doc.line(Math.min(position.line, doc.lines));
  const end = doc.line(Math.min(Math.max(position.endLine, position.line), doc.lines));
  const from = Math.min(start.from + (position.column ?? 1) - 1, start.to);
  const to = position.endColumn ? Math.min(end.from + position.endColumn - 1, end.to) : from;
  view.dispatch({
    effects: [
      setLinked.of({ from: start.from, to: end.from }),
      ...(reveal ? [EditorView.scrollIntoView(start.from, { y: "center" })] : []),
    ],
    ...(reveal ? { selection: { anchor: from, head: Math.max(to, from) } } : {}),
  });
};

/** The highlighted lines, one-based, or null. */
export const linkedRange = (view: EditorView): { line: number; endLine: number } | null => {
  const linked = view.state.field(linkedField, false);
  if (!linked) return null;
  return { line: view.state.doc.lineAt(linked.from).number, endLine: view.state.doc.lineAt(linked.to).number };
};

/** The editor's selection as a position: whole lines unless it starts or ends inside one. */
export const selectionPosition = (view: EditorView): Position => {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const start = doc.lineAt(from);
  const end = doc.lineAt(to);
  if (from === to) return { line: start.number, endLine: start.number };
  if (from === start.from && (to === end.to || to === end.from)) {
    const last = to === end.from && end.number > start.number ? end.number - 1 : end.number;
    return { line: start.number, endLine: last };
  }
  return { line: start.number, column: from - start.from + 1, endLine: end.number, endColumn: to - end.from + 1 };
};
