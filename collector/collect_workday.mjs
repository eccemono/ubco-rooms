#!/usr/bin/env node
/**
 * Local Workday capture helper.
 *
 * This deliberately does NOT automate sign-in, bypass MFA, or run unattended.
 * You sign in yourself in the Chromium window; the script then saves whatever
 * the Find Course Sections report offers (Excel export, or a DOM snapshot that
 * can be parsed later).
 *
 * Usage:
 *   npm install
 *   npx playwright install chromium
 *   npm run collect
 *
 * Data is written to ../data/raw/ and is never uploaded.
 */

import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data", "raw");
const PROFILE_DIR = path.join(ROOT, ".workday-profile");

const WORKDAY_URL = "https://wd10.myworkday.com/ubc/d/gateway.htmld";

const COMBOS = [
  { key: "2026W1-ug", term: "2026-27 Winter Term 1 (UBC-O)", level: "Undergraduate" },
  { key: "2026W1-grad", term: "2026-27 Winter Term 1 (UBC-O)", level: "Graduate" },
  { key: "2026W2-ug", term: "2026-27 Winter Term 2 (UBC-O)", level: "Undergraduate" },
  { key: "2026W2-grad", term: "2026-27 Winter Term 2 (UBC-O)", level: "Graduate" },
];

const rl = createInterface({ input, output });

async function pause(message) {
  try {
    return await rl.question(`\n${message}\n> `);
  } catch {
    // stdin closed (for example when piped); treat it as a skip.
    return "s";
  }
}

function logStep(message) {
  console.log(`\n\x1b[36m${message}\x1b[0m`);
}

async function chooseCombo() {
  const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
  if (only) {
    const combo = COMBOS.find((c) => c.key === only);
    if (!combo) {
      console.error(`Unknown --only value. Use one of: ${COMBOS.map((c) => c.key).join(", ")}`);
      process.exit(1);
    }
    return [combo];
  }
  return COMBOS;
}

async function clickFirstVisible(page, locators, { timeout = 2500 } = {}) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.click({ timeout }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function tryExport(page, combo) {
  const exportCandidates = [
    page.getByRole("button", { name: /export.*(excel|spreadsheet)|excel.*export/i }),
    page.getByRole("button", { name: /^export$/i }),
    page.locator('[title*="Export" i]').filter({ visible: true }),
    page.locator('[aria-label*="Export" i]').filter({ visible: true }),
    page.locator('[data-automation-id*="export" i]').filter({ visible: true }),
    page.locator('button:has-text("Export")').filter({ visible: true }),
  ];

  const downloadPromise = page
    .waitForEvent("download", { timeout: 12000 })
    .catch(() => null);

  const clicked = await clickFirstVisible(page, exportCandidates);
  if (!clicked) return false;

  // Workday often shows an "Export Document" dialog with a second Download button.
  await page.waitForTimeout(900);
  const dialogCandidates = [
    page.getByRole("dialog").getByRole("button", { name: /^download$/i }),
    page.getByRole("button", { name: /^download$/i }),
    page.locator('a:has-text("Download")').filter({ visible: true }),
  ];
  await clickFirstVisible(page, dialogCandidates, { timeout: 2000 });

  const download = await downloadPromise;
  if (download) {
    const suggested = download.suggestedFilename() || `${combo.key}.xlsx`;
    const target = path.join(RAW_DIR, `${combo.key}-${suggested}`);
    await download.saveAs(target);
    console.log(`  saved export: ${path.relative(ROOT, target)}`);
    return true;
  }

  // Some Workday tenants open a notification with a "Download" link instead.
  await page.waitForTimeout(1500);
  const fallback = page.getByRole("link", { name: /download/i }).filter({ visible: true });
  if (await fallback.count()) {
    const [newPage] = await Promise.all([
      page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null),
      fallback.first().click().catch(() => {}),
    ]);
    if (newPage) {
      await newPage.waitForLoadState("domcontentloaded").catch(() => {});
      const body = await newPage.locator("body").innerText().catch(() => "");
      if (body) {
        await writeFile(path.join(RAW_DIR, `${combo.key}-download-page.txt`), body);
        console.log(`  captured download page text (${body.length} chars)`);
        return true;
      }
    }
  }

  return false;
}

async function expandAndLoadAll(page) {
  const expand = page.getByRole("button", { name: /expand all/i });
  if (await expand.count().catch(() => 0)) {
    for (let i = 0; i < await expand.count(); i += 1) {
      if (await expand.nth(i).isVisible().catch(() => false)) {
        await expand.nth(i).click().catch(() => {});
        await page.waitForTimeout(1200);
        break;
      }
    }
  }

  // Click any "Load more" / "Show more" controls, then scroll the largest
  // scrollable container to force virtualised rows to render.
  for (let round = 0; round < 40; round += 1) {
    const more = page.getByRole("button", { name: /load more|show more|more results/i }).filter({ visible: true });
    if (await more.count().catch(() => 0)) {
      await more.first().click().catch(() => {});
      await page.waitForTimeout(700);
    } else {
      break;
    }
  }

  await page.evaluate(async () => {
    const scrollables = [...document.querySelectorAll("*")]
      .filter((el) => el.scrollHeight > el.clientHeight + 200)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 3);
    for (const el of scrollables) {
      let last = 0;
      for (let i = 0; i < 300; i += 1) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 120));
        if (el.scrollHeight === last && i > 3) break;
        last = el.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(700);
}

async function scrapeDom(page, combo) {
  await expandAndLoadAll(page);
  const data = await page.evaluate(() => {
    const textOf = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();

    const tables = [];
    const tableEls = [
      ...document.querySelectorAll('[role="grid"], [role="table"], [data-automation-id*="grid" i], table'),
    ];
    for (const table of tableEls) {
      const headerEls = [...table.querySelectorAll('[role="columnheader"], thead th')];
      const headers = headerEls.map(textOf).filter(Boolean);
      const rows = [];
      const rowEls = [...table.querySelectorAll('[role="row"], tbody tr')];
      for (const row of rowEls) {
        const cells = [...row.querySelectorAll('[role="gridcell"], [role="cell"], td, th')];
        const values = cells.map(textOf);
        if (values.some(Boolean)) rows.push(values);
      }
      if (rows.length) tables.push({ headers, rows });
    }

    const headings = [...document.querySelectorAll("h1,h2,h3,[role=heading]")]
      .map(textOf)
      .filter(Boolean)
      .slice(0, 40);

    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      headings,
      tables,
      bodyText: document.body.innerText.slice(0, 2_000_000),
    };
  });

  const jsonPath = path.join(RAW_DIR, `${combo.key}-page.json`);
  const htmlPath = path.join(RAW_DIR, `${combo.key}-page.html`);
  await writeFile(jsonPath, JSON.stringify({ combo, ...data }, null, 2));
  await writeFile(htmlPath, await page.content());
  console.log(`  saved DOM snapshot: ${path.relative(ROOT, jsonPath)}`);
  console.log(`  saved page HTML:     ${path.relative(ROOT, htmlPath)}`);
  console.log(`  tables found: ${data.tables.length}; text length: ${data.bodyText.length}`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const combos = await chooseCombo();

  logStep("Starting a local Chromium window. Sign in yourself; this script never sees your password.");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.HEADLESS === "1",
    acceptDownloads: true,
    viewport: { width: 1440, height: 960 },
    downloadsPath: RAW_DIR,
  });

  let downloadCount = 0;
  context.on("page", (page) => {
    page.on("download", async (download) => {
      downloadCount += 1;
      const suggested = download.suggestedFilename() || `download-${downloadCount}`;
      const target = path.join(RAW_DIR, `download-${Date.now()}-${suggested}`);
      await download.saveAs(target);
      console.log(`  saved browser download: ${path.relative(ROOT, target)}`);
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(WORKDAY_URL, { waitUntil: "domcontentloaded" }).catch((error) => {
    console.warn(`Could not open Workday automatically: ${error.message}`);
  });

  console.log(`
\x1b[1mWhat to do in the browser\x1b[0m
  1. Sign in with CWL and complete MFA.
  2. Open Academics → Registration & Courses → Find Course Sections.
  3. Choose the term and academic level listed below.
  4. Run the search and wait until the full results table is visible.
  5. Come back to this terminal and press Enter. The script will try the
     built-in Excel export first, then fall back to saving the page DOM.
`);

  for (const combo of combos) {
    // Workday may open the report in a new tab; always act on the newest tab.
    const activePage = context.pages().filter((p) => !p.isClosed()).at(-1) || page;
    logStep(`Next: ${combo.term} · ${combo.level}`);
    console.log(`  Set "Start Date within" to: ${combo.term}`);
    console.log(`  Set "Academic Level" to: ${combo.level}`);
    console.log(`  Do NOT choose "Academic Level Not Applicable".`);
    const answer = await pause("Press Enter when the results table is visible (or type s + Enter to skip).");
    if (/^s/i.test(answer.trim())) {
      console.log("  skipped.");
      continue;
    }
    await activePage.bringToFront().catch(() => {});

    const exported = await tryExport(activePage, combo);
    if (!exported) {
      console.log("  No Excel export found; capturing the visible page instead.");
      console.log("  If this is a Workday table, you can also use the toolbar's Excel icon manually.");
      await scrapeDom(activePage, combo);
    }
  }

  logStep("Capture complete.");
  console.log(`Files are in ${RAW_DIR}`);
  console.log("Next: run the importer described in README.md, or send the raw files back for parser tuning.");
  await pause("Press Enter to close the browser.");
  await context.close();
  rl.close();
}

main().catch(async (error) => {
  console.error("\nCapture failed:", error);
  rl.close();
  process.exit(1);
});
