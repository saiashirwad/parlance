/**
 * The page's side of the TypeScript worker, and the editor features for a `.ts` tab:
 * diagnostics, hover, completion, and go-to-definition, which follows a guest surface back into
 * the guest file through its TsDoc mappings.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { linter } from "@codemirror/lint";
import { type Extension, StateEffect } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, ViewPlugin } from "@codemirror/view";
import type { TsMethods } from "../ts-worker.ts";

export type TsRequest = { readonly id: number; readonly method: keyof TsMethods; readonly params: unknown };
export type TsResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };

type Result<M extends keyof TsMethods> = ReturnType<TsMethods[M]>;
type Params<M extends keyof TsMethods> = Parameters<TsMethods[M]>[0];

export type TsClient = {
  readonly call: <M extends keyof TsMethods>(method: M, params: Params<M>) => Promise<Result<M>>;
  /** Re-checks every `.ts` editor, after a surface or another file changed. */
  readonly recheck: () => void;
  readonly extension: (path: string) => Extension;
};

/** Surfaces changed: lint the `.ts` editors again. */
const recheckEffect = StateEffect.define<null>();

export type TsHooks = {
  /** Shows a definition outside the file: a guest surface offset or another `.ts` file. */
  readonly jump: (path: string, offset: number) => void;
};

export const tsClient = (hooks: TsHooks): TsClient => {
  const worker = new Worker(new URL("../ts-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  worker.addEventListener("message", ({ data }: MessageEvent<TsResponse>) => {
    const waiting = pending.get(data.id);
    pending.delete(data.id);
    if (data.error !== undefined) waiting?.reject(new Error(data.error));
    else waiting?.resolve(data.result);
  });
  const call = <M extends keyof TsMethods>(method: M, params: Params<M>): Promise<Result<M>> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, params } satisfies TsRequest);
    });

  const views = new Set<EditorView>();

  const extension = (path: string): Extension => {
    const sync = (view: EditorView) => call("files", { files: { [path]: view.state.doc.toString() } });

    const definition = (view: EditorView, pos: number): boolean => {
      void sync(view).then(() => call("definition", { path, pos })).then((found) => {
        if (!found) return;
        if (found.path === path) view.dispatch({ selection: { anchor: found.start }, scrollIntoView: true });
        else hooks.jump(found.path, found.start);
      });
      return true;
    };

    const complete = async (context: CompletionContext): Promise<CompletionResult | null> => {
      const word = context.matchBefore(/[\w$]*/);
      if (!context.explicit && (!word || word.from === word.to) && !/[.]$/.test(context.state.sliceDoc(context.pos - 1, context.pos))) return null;
      await call("files", { files: { [path]: context.state.doc.toString() } });
      const result = await call("completions", { path, pos: context.pos });
      if (!result) return null;
      return {
        from: result.from ?? word?.from ?? context.pos,
        options: result.options.map((option) => ({ label: option.label, type: completionType(option.kind), boost: -Number(option.sortText) || 0 })),
        validFor: /^[\w$]*$/,
      };
    };

    return [
      javascript({ typescript: true }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) void sync(update.view);
      }),
      ViewPlugin.define((view) => {
        views.add(view);
        return { destroy: () => void views.delete(view) };
      }),
      linter(async (view) => {
        await sync(view);
        const diagnostics = await call("diagnostics", { path });
        return diagnostics.map((entry) => ({ ...entry, severity: entry.severity as "error" | "warning" | "info" }));
      }, { delay: 250, needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((effect) => effect.is(recheckEffect))) }),
      hoverTooltip(async (view, pos) => {
        const info = await call("hover", { path, pos });
        if (!info) return null;
        return {
          pos: info.from,
          end: info.to,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-documentation";
            const code = document.createElement("pre");
            code.textContent = info.code;
            dom.append(code);
            if (info.docs) dom.append(Object.assign(document.createElement("p"), { textContent: info.docs }));
            return { dom };
          },
        };
      }, { hoverTime: 250 }),
      autocompletion({ override: [complete] }),
      keymap.of([{ key: "F12", run: (view) => definition(view, view.state.selection.main.head) }]),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          event.preventDefault();
          view.dispatch({ selection: { anchor: pos } });
          return definition(view, pos);
        },
      }),
    ];
  };

  const recheck = () => {
    for (const view of views) view.dispatch({ effects: recheckEffect.of(null) });
  };

  return { call, recheck, extension };
};

const completionType = (kind: string): string =>
  kind === "function" || kind === "method" ? kind
  : kind === "property" || kind === "getter" ? "property"
  : kind === "class" || kind === "interface" || kind === "type" || kind === "enum" ? "type"
  : kind === "keyword" ? "keyword"
  : kind === "module" ? "namespace"
  : "variable";
