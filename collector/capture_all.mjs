#!/usr/bin/env node
/**
 * Capture the full Find Course Sections report as visible text by scrolling
 * Workday's lazy-loaded result list. No Excel export required.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data", "raw");
const PROFILE = path.join(ROOT, ".workday-profile");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(RAW, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1500, height: 950 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.setDefaultTimeout(20_000);

async function login() {
  await page.goto("https://wd10.myworkday.com/ubc/d/gateway.htmld", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(3000);
  const body = await page.locator("body").innerText().catch(() => "");
  if (/CWL Authentication|Login Name|Password/i.test(body)) {
    console.log("Signing in...");
    const btn = page.getByRole("button", { name: /^login$/i }).first();
    if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
    await page.waitForTimeout(9000);
  }
}

async function openReport() {
  const search = page.locator('[data-automation-id="globalSearchInput"]').first();
  await search.click();
  await search.fill("Find Course Sections");
  await page.waitForTimeout(1200);
  await search.press("Enter");
  await page.waitForTimeout(4500);
  await page.locator('[data-automation-id="pex-search-results-header-title-link"]').first().click();
  await page.waitForTimeout(5000);
}

async function chooseTerm(which) {
  const input = page.locator('[data-automation-id="multiSelectContainer"] input').nth(0);
  await input.click();
  await page.waitForTimeout(500);
  const group = which === "current" ? "Current Periods" : "Future Periods";
  const term = which === "current" ? "2026-27 Winter Term 1 (UBC-O)" : "2026-27 Winter Term 2 (UBC-O)";
  await page.getByText(group, { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByText("2026-27 UBC-O Academic Year", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator('[data-automation-id="promptOption"]').filter({ hasText: term }).first().click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function chooseLevels() {
  const input = page.locator('[data-automation-id="multiSelectContainer"] input').nth(1);
  await input.click();
  await page.waitForTimeout(600);
  for (const level of ["Graduate", "Undergraduate"]) {
    await page.locator('[data-automation-id="promptOption"]').filter({ hasText: new RegExp(`^${level}$`) }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function runReport() {
  await page.waitForTimeout(1000);
  const ok = page.locator('[data-automation-id="wd-CommandButton_uic_okButton"]').first();
  await ok.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  if (await ok.isVisible().catch(() => false)) await page.keyboard.press("Enter").catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    const body = await page.locator("body").innerText().catch(() => "");
    const m = body.match(/([\d,]+)\s+Results/i);
    if (m && Number(m[1].replaceAll(",", "")) > 0) {
      console.log("Results:", m[0]);
      return Number(m[1].replaceAll(",", ""));
    }
  }
  return 0;
}

async function main() {
  await login();
  await openReport();
  await chooseTerm("current");
  await chooseTerm("future");
  await chooseLevels();
  const total = await runReport();
  if (!total) throw new Error("No results");

  const expand = page.locator('[data-automation-id="expandAll"]').first();
  if (await expand.count().catch(() => 0)) {
    await expand.click().catch(() => {});
    console.log("Clicked Expand All");
    await page.waitForTimeout(2500);
  }

  let stable = 0;
  let last = 0;
  for (let round = 0; round < 200; round += 1) {
    await page.mouse.move(1000, 700).catch(() => {});
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, 4000).catch(() => {});
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
    const body = await page.locator("body").innerText().catch(() => "");
    const count = (body.match(/Section Details/g) || []).length;
    if (round % 5 === 0) console.log(`round ${round}: ${count} section-detail blocks`);
    if (count <= last) stable += 1;
    else stable = 0;
    last = count;
    if (count >= total * 2) break;
    if (stable >= 8) {
      console.log("No growth for 8 rounds; stopping.");
      break;
    }
  }

  const body = await page.locator("body").innerText().catch(() => "");
  const out = {
    url: page.url(),
    title: await page.title(),
    capturedAt: new Date().toISOString(),
    headings: [],
    tables: [],
    bodyText: body,
  };
  const target = path.join(RAW, "all-page.json");
  await writeFile(target, JSON.stringify(out, null, 2));
  await writeFile(path.join(RAW, "all-page.html"), await page.content());
  console.log("Wrote", target, "chars", body.length, "section details", (body.match(/Section Details/g) || []).length);
  await page.screenshot({ path: "/tmp/opencode/capture-all.png", fullPage: false }).catch(() => {});
  await ctx.close();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await ctx.close().catch(() => {});
  process.exit(1);
});
