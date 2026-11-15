import { expect, type Page, test } from "@playwright/test";

const editor = (page: Page) => page.locator("#editors > .cm-editor:not([hidden]) .cm-content");
const tab = (page: Page, name: string) => page.locator(`#files [data-file="${name}"]`);
const output = (page: Page, panel: string) => page.locator(`#outputs [data-panel="${panel}"]`);

/** Replaces the active editor's text, as typing would. */
const replace = async (page: Page, text: string) => {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("language server ready");
});

test("calc runs, hovers, completes, and reports a broken edit", async ({ page }) => {
  await expect(page.locator("#console")).toContainText("250");
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
    machine: "state Paid",
    shade: "ran on cpu",
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
  await replace(page, "show 6 * 7;\n");
  await expect(page).toHaveURL(/#calc:/);
  await page.reload();
  await expect(page.locator("#console")).toContainText("42");
});
