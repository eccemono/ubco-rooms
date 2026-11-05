#!/usr/bin/env node
/**
 * Capture the UBC SWS Okanagan room timetable as tab-separated text.
 *
 * Interactive (first run / re-login):
 *   node collector/capture_sws.mjs --interactive
 *
 * Unattended (daily timer), using an exported authenticated storage state:
 *   node collector/capture_sws.mjs --storage-state=collector/.sws-storage-state.json
 *
 * The scheduled mode never prompts for CWL or Duo. If the saved session has
 * expired it exits with code 2 and leaves the previous data untouched.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, fallback = null) {
  const hit = process.argv.find((v) => v.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const repo = path.resolve(import.meta.dirname, "..");
const profile = arg("profile", path.join(os.homedir(), ".ubco-sws-profile"));
const storageState = arg("storage-state", path.join(repo, "collector/.sws-storage-state.json"));
const output = arg("output", path.join(repo, "data/raw/sws-2026-27-allrooms-allweeks.txt"));
const htmlOutput = arg("html", "");
const scope = arg("scope", "all"); // all | current
const interactive = has("interactive");
const headless = !interactive;
const timeout = Number(arg("timeout", "180000"));
const base = "https://sws-oka.as.it.ubc.ca/sws_2026/";

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

async function openContext() {
  if (!interactive && fs.existsSync(storageState)) {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1500, height: 950 },
    });
    return { browser, context, close: async () => browser.close() };
  }
  const context = await chromium.launchPersistentContext(profile, {
    headless,
    viewport: { width: 1500, height: 950 },
    args: ["--no-first-run"],
  });
  return { browser: null, context, close: async () => context.close() };
}

const { context, close } = await openContext();
let exitCode = 0;
try {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1000);

  let text = await page.locator("body").innerText().catch(() => "");
  if (/Access was denied|session could not be established/i.test(text)) {
    throw new Error("SWS access policy denied the saved session");
  }

  // SWS home has a Rooms postback link, not a normal href.
  if ((await page.locator("#dlObject option").count()) === 0) {
    const roomsLink = page.getByRole("link", { name: "Rooms", exact: true });
    if (await roomsLink.count()) {
      await roomsLink.click();
      await page.waitForTimeout(1800);
    }
  }

  const ready = await page.locator("#dlObject option").count();
  if (!ready) {
    text = await page.locator("body").innerText().catch(() => "");
    if (/CWL Authentication|Secure logon|UBC VPNLESS/i.test(text) || page.url().includes("my.policy")) {
      throw new Error("AUTH_REQUIRED: saved SWS session is missing or expired");
    }
    throw new Error("Rooms form did not load");
  }

  const rooms = await page.evaluate(() =>
    [...document.querySelectorAll("#dlObject option")].map((o) => ({ value: o.value, label: o.text.trim() }))
  );
  const weekValue =
    scope === "current"
      ? await page.evaluate(() => [...document.querySelectorAll("#lbWeeks option")].find((o) => o.text.trim() === "This Week")?.value)
      : await page.evaluate(() => [...document.querySelectorAll("#lbWeeks option")].find((o) => o.text.trim() === "All Weeks")?.value);
  if (!weekValue) throw new Error(`Could not find week option for scope=${scope}`);

  log("rooms", rooms.length, "scope", scope, "week", weekValue);
  await page.selectOption("#dlObject", rooms.map((r) => r.value));
  await page.selectOption("#lbWeeks", weekValue);
  await page.selectOption("#lbDays", { label: "All Days" });
  await page.selectOption("#dlPeriod", { label: "All Day 07:00 - 22:00" });
  await page.selectOption("#dlType", { label: "List Timetable" });

  const t0 = Date.now();
  const popupP = context.waitForEvent("page", { timeout });
  await page.click("#bGetTimetable");
  const out = await popupP;
  await out.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
  // The all-weeks page can be large; allow the table to render.
  await out.waitForSelector("table.spreadsheet", { timeout }).catch(() => {});
  await out.waitForTimeout(1000);
  text = await out.locator("body").innerText();
  if (!text.includes("Exported Weeks:")) throw new Error("Output page did not contain an SWS timetable");

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text, "utf8");
  if (htmlOutput) {
    fs.mkdirSync(path.dirname(htmlOutput), { recursive: true });
    fs.writeFileSync(htmlOutput, await out.content(), "utf8");
  }
  const rows = text.split("\n").filter((line) => line.split("\t").length >= 11).length;
  log("captured", output, "bytes", fs.statSync(output).size, "rows", rows, "ms", Date.now() - t0);
  console.log("SWS_CAPTURE_OK", JSON.stringify({ output, rows, bytes: fs.statSync(output).size, scope }));
} catch (error) {
  exitCode = /AUTH_REQUIRED|access policy|CWL Authentication|Secure logon/i.test(error.message) ? 2 : 1;
  console.error("SWS_CAPTURE_FAILED", error.message);
} finally {
  await close().catch(() => {});
  process.exit(exitCode);
}
