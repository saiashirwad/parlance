import { expect, type Page, test } from "@playwright/test";

const editor = (page: Page) => page.locator("#editors > .cm-editor:not([hidden]) .cm-content");
const tab = (page: Page, name: string) => page.locator(`#files [data-file="${name}"]`);
const output = (page: Page, panel: string) => page.locator(`#outputs [data-panel="${panel}"]`);

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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});

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

test("the URL hash keeps edits", async ({ page }) => {
  await replace(page, "let subtotal = 6;\nlet freeShipping = true;\nshow subtotal * 7;\n");
  await expect(page).toHaveURL(/#calc:/);
  await page.reload();
  await expect(page.locator("#console")).toContainText("42");
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
