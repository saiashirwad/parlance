import { expect, type Page, test } from "@playwright/test";

const editor = (page: Page) => page.locator("#editors > .cm-editor:not([hidden]) .cm-content");
const tab = (page: Page, name: string) => page.locator(`#files [data-file="${name}"]`);
const output = (page: Page, panel: string) => page.locator(`#outputs [data-panel="${panel}"]`);
/** A line number in the visible editor's gutter (not the hidden spacer that sizes it). */
const lineNumber = (page: Page, line: number) =>
  page.locator("#editors > .cm-editor:not([hidden]) .cm-lineNumbers .cm-gutterElement:not([style*=hidden])")
    .getByText(String(line), { exact: true });
const linked = (page: Page) => page.locator("#editors > .cm-editor:not([hidden]) .cm-linked");

/** Names a new file with the + at the end of the tab bar. */
const create = async (page: Page, name: string) => {
  await page.locator("#files .add").click();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
};

/** Renames a file by double-clicking its tab. */
const rename = async (page: Page, from: string, to: string) => {
  await tab(page, from).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(to);
  await page.keyboard.press("Enter");
  await expect(tab(page, to)).toBeVisible();
};

/** The center of `word` on the visible line containing `line`, for hovering and clicking. */
const wordAt = async (page: Page, line: string, word: string) => {
  const box = await editor(page).evaluate((content, [line, word]) => {
    const element = [...content.querySelectorAll(".cm-line")].find((entry) => entry.textContent!.includes(line!));
    if (!element) return null;
    let offset = element.textContent!.indexOf(line!) + line!.indexOf(word!);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (offset < length) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(offset + word!.length, length));
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      offset -= length;
    }
    return null;
  }, [line, word]);
  if (!box) throw new Error(`${word} is not on a visible line with ${line}`);
  return box;
};

/** Replaces the active editor's text, as typing would. */
const replace = async (page: Page, text: string) => {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
};

const ready = async (page: Page, path = "/") => {
  await page.goto(path);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
};

test.beforeEach(async ({ page }) => ready(page));

test("calc runs, hovers, completes, and reports a broken edit", async ({ page }) => {
  await expect(page.locator("#console")).toContainText("250 125 true");
  // Semantic tokens and inlay hints arrive from the server.
  await expect(editor(page).locator(".tk-keyword").first()).toHaveText("let");
  await expect(editor(page).locator(".cm-inlay-hint").first()).toContainText("number");

  await editor(page).getByText("subtotal", { exact: true }).first().hover();
  await expect(page.locator(".cm-tooltip-hover")).toContainText("number");

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nshow sub");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("subtotal");
  await page.keyboard.press("Escape");

  await replace(page, "let x = 1 + true;\nshow y;\n");
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible();
  await expect(page.locator("#problem-count")).toBeVisible();
  await output(page, "problems").click();
  await expect(page.locator("#problems")).toContainText("demo.calc:1:");
  await expect(page.locator("#problems")).toContainText("demo.calc:2:");
});

test("calc edits propagate to importers, and definitions cross tabs", async ({ page }) => {
  await tab(page, "imports.calc").click();
  await editor(page).getByText("base", { exact: true }).click();
  await page.keyboard.press("F12");
  await expect(tab(page, "lib.calc")).toHaveAttribute("aria-selected", "true");

  await replace(page, "let bass = 1;\n");
  await expect(tab(page, "imports.calc").locator(".dot")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tab(page, "imports.calc").locator(".dot")).toHaveCount(0);
});

test("every example runs", async ({ page }) => {
  const expected: Record<string, string> = {
    advanced: "The answer is:",
    schema: "CREATE TABLE",
    machine: "Paid Checkout Paid pay 50",
    shade: "particle 0.095 0.907 0 | 0.95 -0.931 0 | alpha 0.95",
    grammar: "A grammar does not run",
  };
  for (const [language, text] of Object.entries(expected)) {
    await page.selectOption("#language", language);
    await expect(page.locator("#console")).toContainText(text);
    await expect(page.locator("#console .error")).toHaveCount(0);
  }
});

test("shade emits WGSL and its TypeScript surface", async ({ page }) => {
  await page.selectOption("#language", "shade");
  await output(page, "emit").click();
  await page.selectOption("#target", "wgsl");
  await expect(page.locator("#emit-view")).toContainText("@compute @workgroup_size(64, 1, 1)");
  await output(page, "ts").click();
  await expect(page.locator("#ts-view")).toContainText("Particle");
});


test("TypeScript checks against guest surfaces and jumps into guest files", async ({ page }) => {
  await tab(page, "calc.ts").click();
  const use = await wordAt(page, "= subtotal;", "subtotal");
  await page.mouse.move(use.x, use.y);
  await expect(page.locator(".cm-tooltip-hover")).toContainText("const subtotal: number");

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("freeS");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("freeShipping");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");

  await page.mouse.click(use.x, use.y);
  await page.keyboard.press("F12");
  await expect(tab(page, "demo.calc")).toHaveAttribute("aria-selected", "true");

  // Renaming a guest binding breaks the TypeScript that imports it.
  await replace(page, "let total = 85 + 40;\nlet freeShipping = total == 125;\nshow total * 2;\n");
  await tab(page, "calc.ts").click();
  await expect(editor(page).locator(".cm-lintRange-error").first()).toBeVisible();
  await expect(editor(page).locator(".cm-lintRange-error").first()).toHaveText("subtotal");
});

test.describe("links", () => {
  test("a deep link opens the file and highlights its lines", async ({ page }) => {
    await ready(page, "/calc/lib.calc#L2-L3");
    await expect(tab(page, "lib.calc")).toHaveAttribute("aria-selected", "true");
    await expect(linked(page)).toHaveCount(2);
    await expect(linked(page).first()).toContainText("let limit");
    await expect(page).toHaveURL(/\/calc\/lib\.calc#L2-L3$/);

    await ready(page, "/shade/particles.gpu#L5:3");
    await expect(page.locator("#language")).toHaveValue("shade");
    await expect(linked(page)).toHaveCount(1);
  });

  test("clicking line numbers links lines, and back and forward follow tabs", async ({ page }) => {
    await lineNumber(page, 1).click();
    await expect(page).toHaveURL(/\/calc\/demo\.calc#L1$/);
    await lineNumber(page, 3).click({ modifiers: ["Shift"] });
    await expect(page).toHaveURL(/\/calc\/demo\.calc#L1-L3$/);
    await expect(linked(page)).toHaveCount(3);

    await tab(page, "imports.calc").click();
    await expect(page).toHaveURL(/\/calc\/imports\.calc$/);
    await expect(linked(page)).toHaveCount(0);
    await page.goBack();
    await expect(tab(page, "demo.calc")).toHaveAttribute("aria-selected", "true");
    await expect(linked(page)).toHaveCount(3);
    await page.goForward();
    await expect(tab(page, "imports.calc")).toHaveAttribute("aria-selected", "true");

    // A problem links its line.
    await replace(page, "use \"./lib.calc\";\n\nshow nope;\n");
    await output(page, "problems").click();
    await page.locator("#problems button").first().click();
    await expect(page).toHaveURL(/\/calc\/imports\.calc#L3:6/);
  });
});

test.describe("files", () => {
  test("a new file imports another and gets hover and diagnostics", async ({ page }) => {
    await create(page, "new.calc");
    await expect(page).toHaveURL(/\/calc\/new\.calc#w=/);
    await page.keyboard.insertText("use \"./demo.calc\";\nlet twice = subtotal * 2;\nshow twice;\n");
    await expect(editor(page).locator(".cm-inlay-hint").first()).toContainText("number");
    const use = await wordAt(page, "= subtotal * 2", "subtotal");
    await page.mouse.move(use.x, use.y);
    await expect(page.locator(".cm-tooltip-hover")).toContainText("number");
    await expect(page.locator("#console")).toContainText("250 125 true");

    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("show missing;\n");
    await expect(tab(page, "new.calc").locator(".dot")).toBeVisible();
    await output(page, "problems").click();
    await expect(page.locator("#problems")).toContainText("new.calc:4:");

    // A name without a registered extension is refused in place.
    await page.locator("#files .add").click();
    await page.keyboard.type("notes.txt");
    await page.keyboard.press("Enter");
    await expect(page.locator("#files .tab-input")).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#files .tab-input")).toHaveCount(0);
  });

  test("renaming a file breaks its importers, and renaming it back fixes them", async ({ page }) => {
    await rename(page, "lib.calc", "base.calc");
    await expect(tab(page, "imports.calc").locator(".dot")).toBeVisible();
    await rename(page, "base.calc", "lib.calc");
    await expect(tab(page, "imports.calc").locator(".dot")).toHaveCount(0);

    // TypeScript sees the guest file's surface go and come back.
    await rename(page, "demo.calc", "price.calc");
    await tab(page, "calc.ts").click();
    await expect(editor(page).locator(".cm-lintRange-error").first()).toBeVisible();
    await rename(page, "price.calc", "demo.calc");
    await tab(page, "calc.ts").click();
    await expect(editor(page).locator(".cm-lintRange-error")).toHaveCount(0);
  });

  test("deleting a file leaves its importer unresolved", async ({ page }) => {
    page.once("dialog", (dialog) => void dialog.accept());
    await tab(page, "lib.calc").hover();
    await tab(page, "lib.calc").locator(".close").click();
    await expect(tab(page, "lib.calc")).toHaveCount(0);
    await output(page, "problems").click();
    await expect(page.locator("#problems")).toContainText("imports.calc:1:");
    await expect(page.locator("#problems")).toContainText("lib.calc");
  });

  test("the workspace survives a reload and resets to the example", async ({ page }) => {
    await create(page, "kept.calc");
    await page.keyboard.insertText("show 7 * 6;\n");
    await expect(page).toHaveURL(/#w=/);
    await ready(page, "/");
    await expect(tab(page, "kept.calc")).toBeVisible();
    await tab(page, "kept.calc").click();
    await expect(editor(page)).toContainText("show 7 * 6;");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.selectOption("#language", "reset");
    await expect(tab(page, "kept.calc")).toHaveCount(0);
    await expect(page).not.toHaveURL(/w=/);
    await ready(page, "/");
    await expect(tab(page, "kept.calc")).toHaveCount(0);
  });

  test("a shared URL carries the whole workspace and the linked lines", async ({ page, browser }) => {
    // A mixed workspace: a calc file that imports a new schema file.
    await create(page, "rates.schema");
    await page.keyboard.insertText("schema Rates\n\nmodel Rate {\n  id: Int @primary @auto\n}\n");
    await create(page, "mixed.calc");
    await page.keyboard.insertText("use \"./rates.schema\";\nshow 7 * 6;\n");
    await tab(page, "demo.calc").click();
    await replace(page, "let subtotal = 6;\nlet freeShipping = true;\nshow subtotal * 7;\n");
    await lineNumber(page, 2).click();
    await expect(page).toHaveURL(/\/calc\/demo\.calc#L2&w=/);
    const url = page.url();

    const other = await (await browser.newContext()).newPage();
    await ready(other, url);
    await expect(tab(other, "rates.schema")).toBeVisible();
    await expect(tab(other, "mixed.calc")).toBeVisible();
    await expect(tab(other, "mixed.calc").locator(".dot")).toHaveCount(0);
    await expect(linked(other)).toHaveCount(1);
    await expect(linked(other)).toContainText("let freeShipping");
    await expect(other.locator("#console")).toContainText("42");
    expect(other.url()).toBe(url);
  });
});
