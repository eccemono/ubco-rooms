#!/usr/bin/env node
/**
 * Auto-export mode: opens Workday, gives you time to sign in and run the
 * combined Find Course Sections search, then clicks Workday's Excel button
 * and saves the download.
 *
 * Usage:
 *   node auto_export.mjs
 *   node auto_export.mjs --wait=120
 *
 * No password is handled by this script. Sign in yourself.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data", "raw");
const PROFILE_DIR = path.join(ROOT, ".workday-profile");
const WORKDAY_URL = "https://wd10.myworkday.com/ubc/d/gateway.htmld";

const waitArg = process.argv.find((arg) => arg.startsWith("--wait="));
const WAIT_SECONDS = Math.max(20, Number(waitArg?.split("=")[1]) || 60);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  console.log(`
Workday auto-export
-------------------
A Chromium window will open. In that window:
  1. Sign in with CWL + MFA.
  2. Open Find Course Sections.
  3. Select BOTH 2026-27 Winter Term 1 and Term 2 (UBC-O).
  4. Select Graduate and Undergraduate.
  5. Click OK and wait for the results.

The script waits ${WAIT_SECONDS}s, then clicks Workday's Excel button automatically.
If the page is not ready, it keeps waiting (up to 10 minutes).
`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1500, height: 950 },
    downloadsPath: RAW_DIR,
  });

  let saved = null;
  const wireDownload = (p) => {
    p.on("download", async (download) => {
      const suggested = download.suggestedFilename() || "workday-export.xlsx";
      const target = path.join(RAW_DIR, `all-${suggested}`);
      await download.saveAs(target);
      saved = target;
      console.log(`\nSaved download: ${path.relative(ROOT, target)}`);
    });
  };
  context.pages().forEach(wireDownload);
  context.on("page", wireDownload);

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(WORKDAY_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  const deadline = Date.now() + Math.max(WAIT_SECONDS, 600) * 1000;
  let graceUntil = Date.now() + WAIT_SECONDS * 1000;
  let announced = false;

  while (Date.now() < deadline && !saved) {
    const pages = context.pages().filter((p) => !p.isClosed());
    for (const p of pages) {
      const count = await p.locator('[data-automation-id="excelIconButton"], [title="Export to Excel"]').count().catch(() => 0);
      if (!count) continue;

      // Do not export the empty/default view: require a non-zero result count.
      const body = await p.locator("body").innerText().catch(() => "");
      const resultMatch = body.match(/([\d,]+)\s+Results/i);
      const resultCount = resultMatch ? Number(resultMatch[1].replaceAll(",", "")) : 0;
      if (!resultCount) continue;

      if (!announced) {
        // Give a little time after results appear for any final filter clicks.
        graceUntil = Math.max(graceUntil, Date.now() + 25_000);
        console.log(`\nFound ${resultCount.toLocaleString()} results and the Excel button. Waiting ${Math.ceil((graceUntil - Date.now()) / 1000)}s before export...`);
        announced = true;
      }
      if (Date.now() < graceUntil) continue;

      console.log("\nClicking Export to Excel...");
      // Hovering the report header is what reveals Workday's icon toolbar.
      await p.getByRole("heading", { name: "Find Course Sections" }).hover({ force: true }).catch(() => {});
      await p.getByText(/\d+ Results/).first().hover({ force: true }).catch(() => {});
      await sleep(500);

      const button = p.locator('[data-automation-id="excelIconButton"], [title="Export to Excel"]').first();
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ force: true, timeout: 5000 }).catch(() => {});
      // Direct DOM click bypasses aria-hidden and any invisible overlay.
      const clicked = await p.evaluate(() => {
        const el = document.querySelector('[data-automation-id="excelIconButton"], [title="Export to Excel"]');
        if (!el) return false;
        el.click();
        return true;
      }).catch(() => false);
      if (!clicked) console.log("  Excel button not found in DOM.");

      // Workday may open an export dialog with a second Download button.
      const downloadDeadline = Date.now() + 25_000;
      while (!saved && Date.now() < downloadDeadline) {
        for (const loc of [
          p.getByRole("dialog").getByRole("button", { name: /^download$/i }),
          p.getByRole("button", { name: /^download$/i }),
          p.getByRole("link", { name: /download/i }),
        ]) {
          if (await loc.count().catch(() => 0)) {
            const first = loc.first();
            if (await first.isVisible().catch(() => false)) {
              await first.click().catch(() => {});
            }
          }
        }
        await sleep(1000);
      }
      if (!saved) console.log("No download yet; will retry the click on the next loop.");
    }
    await sleep(1500);
  }

  if (!saved) {
    console.log("\nNo download captured. If the report is open, click the spreadsheet icon manually and save it into data/raw/.");
  }

  await sleep(1500);
  await context.close();
}

main().catch((error) => {
  console.error("Auto-export failed:", error);
  process.exit(1);
});
