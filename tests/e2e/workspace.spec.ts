/**
 * Browser end-to-end coverage of the TGS workspace.
 *
 * These run against the real dev server, the real Pyodide worker and the real
 * local Deno sandbox — nothing is mocked. Anything needing ANTHROPIC_API_KEY is
 * asserted through its "not configured" path so the suite is deterministic.
 */
import { expect, test, type Page } from "@playwright/test";

const RUNNER_URL = "http://127.0.0.1:8088";

async function openWorkspace(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.goto("/");
  await expect(tab(page, "Raw Data")).toBeVisible();
  await waitForHydration(page);
}

/**
 * The shell is server-rendered, so its markup is on screen before React takes
 * over. Interacting earlier is silently discarded when hydration re-applies the
 * component's own props. A mounted Monaco instance is client-only, so its
 * presence proves hydration finished.
 */
async function waitForHydration(page: Page) {
  await page.locator('[data-tgs-monaco="true"]').first().waitFor({ timeout: 60_000 });
}

/** The six workspace tabs, scoped to the nav so screen-level jump buttons don't collide. */
function tab(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Workspace sections" })
    .getByRole("button", { name, exact: true });
}

function main(page: Page) {
  return page.getByRole("main");
}

test.describe("TGS workspace", () => {
  test("server-renders the six-tab base44 shell", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const html = await response!.text();
    // Proves SSR produced real markup rather than an empty shell.
    expect(html).toContain("Agentsable Tool Workspace");
    expect(html).toContain("Raw Data");

    for (const name of ["Raw Data", "Editor", "Config", "Secrets", "Validator", "Runner"]) {
      await expect(tab(page, name)).toBeVisible();
    }
  });

  test("Raw Data shows the four tool files and renaming renames all four", async ({ page }) => {
    await openWorkspace(page);

    const files = page.getByRole("tablist", { name: "Tool bundle files" });
    await expect(files.getByRole("tab", { name: "calc.ts", exact: true })).toBeVisible();
    await expect(files.getByRole("tab", { name: "calc.json", exact: true })).toBeVisible();
    await expect(files.getByRole("tab", { name: "calc.env", exact: true })).toBeVisible();
    await expect(files.getByRole("tab", { name: "calc_tests.json", exact: true })).toBeVisible();

    const nameInput = page.getByLabel("Tool name");
    await nameInput.fill("weather_fetcher");
    await nameInput.blur();

    await expect(files.getByRole("tab", { name: "weather_fetcher.ts", exact: true })).toBeVisible();
    await expect(
      files.getByRole("tab", { name: "weather_fetcher_tests.json", exact: true }),
    ).toBeVisible();
  });

  test("Editor hides the config block behind the CONFIG_STUB", async ({ page }) => {
    await openWorkspace(page);
    await tab(page, "Editor").click();

    // Scope to the logic editor: the collapsed recombination preview further down
    // legitimately does contain the config block.
    const logicPane = main(page)
      .locator('[data-tgs-monaco="true"], [data-tgs-monaco-fallback="true"]')
      .first();

    await expect(logicPane).toContainText("CONFIG_STUB");
    // The declarative config must not be visible in the logic view.
    await expect(logicPane).not.toContainText("const baseConfig");
    await expect(logicPane).not.toContainText("requestsPerMinute");
  });

  test("Config form edits flow into the .ts through the sync matrix", async ({ page }) => {
    await openWorkspace(page);
    await tab(page, "Config").click();

    await page.getByLabel("Rate limit (requests per minute)").fill("450");
    await page
      .getByRole("button", { name: /^\s*💾?\s*Save to Tool\s*$/ })
      .first()
      .click();

    await tab(page, "Raw Data").click();
    await page
      .getByRole("tablist", { name: "Tool bundle files" })
      .getByRole("tab", { name: "calc.ts", exact: true })
      .click();
    // The recombined .ts is what the AST engine will write to disk.
    await expect(page.getByTestId("raw-pane")).toContainText("requestsPerMinute: 450");
  });

  test("Validator runs the five Python rules in Pyodide and scores the tool", async ({ page }) => {
    test.setTimeout(300_000);
    await openWorkspace(page);
    await tab(page, "Validator").click();

    await page
      .getByRole("button", { name: /Run Python Checks/ })
      .first()
      .click();

    // Pyodide downloads its runtime on the first run.
    await expect(main(page)).toContainText("rule_no_global_fetch.py", { timeout: 260_000 });
    await expect(main(page)).toContainText("rule_cf_worker_compat.py");
    await expect(main(page)).toContainText("rule_has_required_exports.py");
    await expect(main(page)).toContainText("rule_dependencies_declared.py");
    await expect(main(page)).toContainText("rule_network_allowlist.py");

    // The bundled calc tool is spec-compliant, so every deterministic rule passes
    // and the health score is a clean 100 with no publish blockers.
    await expect(main(page)).toContainText(/100\s*\/\s*100/);
    // No finding rendered in the failure state.
    await expect(main(page).locator('.finding[data-state="fail"]')).toHaveCount(0);
  });

  test("Python Rules keeps exactly one rule editor open", async ({ page }) => {
    await openWorkspace(page);
    await tab(page, "Validator").click();
    await page.getByRole("tab", { name: "Python Rules" }).click();

    const editors = page.locator("[aria-label^='Python rule ']");
    await expect(editors).toHaveCount(0);

    await page
      .getByRole("button", { name: /rule_no_global_fetch\.py/ })
      .first()
      .click();
    await expect(editors).toHaveCount(1);
    await expect(page.locator("[aria-label='Python rule rule_no_global_fetch.py']")).toHaveCount(1);

    await page
      .getByRole("button", { name: /rule_cf_worker_compat\.py/ })
      .first()
      .click();
    await expect(editors).toHaveCount(1);
    await expect(page.locator("[aria-label='Python rule rule_cf_worker_compat.py']")).toHaveCount(
      1,
    );
  });

  test("Runner executes every test against the local Deno sandbox", async ({ page }) => {
    test.setTimeout(180_000);
    await openWorkspace(page);
    await tab(page, "Runner").click();

    const url = page.locator("#runner-url");
    await url.fill(RUNNER_URL);
    await url.blur();

    await expect(page.getByTestId("runner-status")).toContainText(/up|healthy|v?\d/i, {
      timeout: 30_000,
    });

    await page
      .getByRole("button", { name: /Run All Tests/ })
      .first()
      .click();

    await expect(main(page)).toContainText("Valid Addition", { timeout: 60_000 });
    await expect(main(page)).toContainText("Divide by Zero Error Handling");
    await expect(main(page)).toContainText("Missing Payload");
    // 2 embedded + 1 external, all green against the real sandbox.
    await expect(main(page)).toContainText("3/3", { timeout: 60_000 });
  });

  test("Secrets renders only declared secrets and states the publish exclusion", async ({
    page,
  }) => {
    await openWorkspace(page);
    await tab(page, "Secrets").click();

    // calc declares no secrets — the screen must say so, not invent fields.
    await expect(main(page)).toContainText("declares no secrets");
    await expect(main(page)).toContainText(".env");
  });

  test("the AI pane reports Claude is not configured instead of faking replies", async ({
    page,
  }) => {
    await openWorkspace(page);
    await expect(page.getByRole("complementary")).toContainText(
      /ANTHROPIC_API_KEY|not configured/i,
      { timeout: 30_000 },
    );
  });
});
