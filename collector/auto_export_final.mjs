#!/usr/bin/env node
/**
 * Fully autonomous Workday export, using the saved CWL login with the owner's
 * explicit permission. Opens Find Course Sections via global search, selects
 * both winter terms and both academic levels, runs the report, and downloads
 * the Excel export.
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
  downloadsPath: RAW,
});

let saved = null;
const wire = (p) => {
  p.on("download", async (d) => {
    const name = d.suggestedFilename() || "workday.xlsx";
    const target = path.join(RAW, `all-${name}`);
    await d.saveAs(target);
    saved = target;
    console.log("SAVED", target);
  });
};
ctx.pages().forEach(wire);
ctx.on("page", wire);

const page = ctx.pages()[0] || (await ctx.newPage());
page.setDefaultTimeout(20_000);

async function login() {
  await page.goto("https://wd10.myworkday.com/ubc/d/gateway.htmld", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(3000);
  const body = await page.locator("body").innerText().catch(() => "");
  if (/CWL Authentication|Login Name|Password/i.test(body)) {
    console.log("Signing in with the saved profile...");
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
  const option = page.locator('[data-automation-id="promptOption"]').filter({ hasText: term }).first();
  await option.click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function chooseLevels() {
  const input = page.locator('[data-automation-id="multiSelectContainer"] input').nth(1);
  await input.click();
  await page.waitForTimeout(600);
  for (const level of ["Graduate", "Undergraduate"]) {
    const option = page.locator('[data-automation-id="promptOption"]').filter({ hasText: new RegExp(`^${level}$`) }).first();
    await option.click().catch(async () => {
      await page.getByText(level, { exact: true }).first().click();
    });
    await page.waitForTimeout(500);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function runReport() {
  await page.waitForTimeout(1000);
  const ok = page.locator('[data-automation-id="wd-CommandButton_uic_okButton"]').first();
  await ok.click({ force: true }).catch((e) => console.log("OK click:", e.message));
  await page.waitForTimeout(1500);

  // If the dialog is still up, Enter activates the focused OK button.
  if (await ok.isVisible().catch(() => false)) {
    console.log("OK still visible; pressing Enter.");
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(1000);
  }
  console.log("Clicked OK; waiting for results...");
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    const body = await page.locator("body").innerText().catch(() => "");
    const m = body.match(/([\d,]+)\s+Results/i);
    if (m && Number(m[1].replaceAll(",", "")) > 0) {
      console.log("Results:", m[0]);
      return Number(m[1].replaceAll(",", ""));
    }
  }
  console.log("No result count appeared.");
  return 0;
}

async function exportExcel() {
  await page.getByRole("heading", { name: "Find Course Sections" }).hover({ force: true }).catch(() => {});
  await page.getByText(/\d+ Results/).first().hover({ force: true }).catch(() => {});
  await page.waitForTimeout(800);

  const related = page.locator('[aria-label*="Related Actions Find Course Sections"]').first();
  console.log("related count", await related.count().catch(() => 0));
  if (await related.count().catch(() => 0)) {
    await related.focus().catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(1500);
    console.log("related expanded", await related.getAttribute("aria-expanded").catch(() => null));
    console.log("menus", await page.locator('[role=menu]').count().catch(() => 0));
    const items = await page.locator('[role=menuitem]').allTextContents().catch(() => []);
    console.log("menuitems", items.slice(0, 30));
    for (const label of ["Export to Excel", "Export", "Download"]) {
      const item = page.getByRole("menuitem", { name: new RegExp(label, "i") }).first();
      if (await item.count().catch(() => 0) && await item.isVisible().catch(() => false)) {
        console.log("clicking menuitem", label);
        await item.click().catch(() => {});
        break;
      }
    }
  }

  const excel = page.locator('[data-automation-id="excelIconButton"], [title="Export to Excel"]').first();
  console.log("excel count", await excel.count().catch(() => 0));

  // Workday hides the report action icons until the results header is hovered.
  // Force the toolbar visible and click the actual icon with the mouse.
  for (const [x, y] of [[1350, 390], [1200, 390], [1000, 390], [800, 390], [750, 96], [335, 96]]) {
    await page.mouse.move(x, y).catch(() => {});
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(700);

  const styleChain = await page.evaluate(() => {
    const btn = document.querySelector('[data-automation-id="excelIconButton"], [title="Export to Excel"]');
    const out = [];
    let el = btn;
    for (let i = 0; i < 12 && el; i += 1) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), display: cs.display, vis: cs.visibility, opacity: cs.opacity, pos: cs.position, w: r.width, h: r.height });
      el = el.parentElement;
    }
    return out;
  }).catch(() => []);
  console.log("style chain", JSON.stringify(styleChain, null, 1));

  const box = await page.evaluate(() => {
    const btn = document.querySelector('[data-automation-id="excelIconButton"], [title="Export to Excel"]');
    if (!btn) return null;
    let wrap = btn.parentElement;
    while (wrap) {
      wrap.style.display = "block";
      wrap.style.visibility = "visible";
      wrap.style.opacity = "1";
      wrap.style.overflow = "visible";
      wrap = wrap.parentElement;
    }
    btn.removeAttribute("aria-hidden");
    for (const [prop, value] of [
      ["display", "block"], ["visibility", "visible"], ["opacity", "1"],
      ["position", "fixed"], ["left", "700px"], ["top", "200px"],
      ["width", "28px"], ["height", "28px"], ["z-index", "2147483647"],
      ["background", "#ff0"],
    ]) {
      btn.style.setProperty(prop, value, "important");
    }
    const r = btn.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  console.log("excel box", box);
  if (box && box.w > 0) {
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2).catch(() => {});
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2).catch(() => {});
    console.log("mouse-clicked excel at", box);
  } else {
    // The icon is hidden inside the report's action toolbar. Open the ...
    // menu in the dark report header instead.
    const related = page.locator('[aria-label*="Related Actions Find Course Sections"]').first();
    console.log("related count", await related.count().catch(() => 0));
    const rb = await related.boundingBox().catch(() => null);
    console.log("related box", rb);
    if (rb) {
      await related.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(1200);
      console.log("related expanded", await related.getAttribute("aria-expanded").catch(() => null));
      console.log("role menu count", await page.locator('[role=menu]').count().catch(() => 0));
      console.log("role menuitem count", await page.locator('[role=menuitem]').count().catch(() => 0));
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2).catch(() => {});
      await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2).catch(() => {});
      await page.waitForTimeout(1800);
      const menuText = await page.locator("body").innerText().catch(() => "");
      console.log("menu tail:", menuText.slice(-1200).replace(/\s+/g, " "));
      const menuItems = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem], [data-automation-id="menuItem"]')].map(el => (el.innerText || el.getAttribute("aria-label") || "").trim()).filter(Boolean));
      console.log("menu items", menuItems.slice(-20));
      for (const label of ["Export to Excel", "Export", "Download"]) {
        const item = page.getByText(label, { exact: false }).last();
        if (await item.count().catch(() => 0) && await item.isVisible().catch(() => false)) {
          console.log("clicking menu item", label);
          await item.click().catch(() => {});
          break;
        }
      }
    }
  }

  for (let i = 0; i < 30 && !saved; i += 1) {
    for (const loc of [
      page.getByRole("dialog").getByRole("button", { name: /^download$/i }),
      page.getByRole("button", { name: /^download$/i }),
      page.getByRole("link", { name: /download/i }),
    ]) {
      if (await loc.count().catch(() => 0)) {
        const first = loc.first();
        if (await first.isVisible().catch(() => false)) {
          await first.click().catch(() => {});
          console.log("clicked Download");
        }
      }
    }
    await sleep(1000);
  }
}

async function main() {
  await login();
  await openReport();
  console.log("Selected term 1...");
  await chooseTerm("current");
  console.log("Selected term 2...");
  await chooseTerm("future");
  console.log("Selected levels...");
  await chooseLevels();

  const before = await page.locator("body").innerText().catch(() => "");
  console.log("prompt state:", before.match(/items selected/gi)?.length, "items markers");
  const count = await runReport();
  if (!count) {
    await page.screenshot({ path: "/tmp/opencode/export-failed.png", fullPage: false }).catch(() => {});
    await writeFile("/tmp/opencode/export-failed.html", await page.content().catch(() => "")).catch(() => {});
    await ctx.close();
    process.exit(2);
  }

  await exportExcel();
  await page.screenshot({ path: "/tmp/opencode/export-done.png", fullPage: false }).catch(() => {});
  if (!saved) {
    console.error("No download captured.");
    await writeFile("/tmp/opencode/export-done.html", await page.content().catch(() => "")).catch(() => {});
    await ctx.close();
    process.exit(3);
  }
  console.log("DONE", saved);
  await sleep(1000);
  await ctx.close();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await ctx.close().catch(() => {});
  process.exit(1);
});
