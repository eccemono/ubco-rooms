#!/usr/bin/env node
/**
 * Open a headed Chromium window at UBC SWS and keep it alive for manual login.
 *
 * The browser profile lives outside the repository, so the authenticated
 * session is never committed. The user enters their own CWL password and
 * approves Duo; this script only keeps the browser open.
 *
 * A localhost-only DevTools port is exposed so a follow-up script can attach
 * and inspect/capture the already-authenticated session.
 *
 * Usage:
 *   node collector/collect_sws.mjs
 *   node collector/collect_sws.mjs --port=9222
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 9222;
const profile = path.join(os.homedir(), ".ubco-sws-profile");
const startUrl = "https://sws-oka.as.it.ubc.ca/sws_2026/";
const statePath = path.join(import.meta.dirname, ".sws-storage-state.json");

console.log(`
UBC SWS session
---------------
Profile: ${profile}
DevTools: http://127.0.0.1:${port}

A Chromium window is opening. Sign in with CWL and complete Duo there.
Leave the window open when you reach the room timetable.
`);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1500, height: 950 },
  args: [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
  ],
});

const pages = context.pages();
const page = pages[0] || (await context.newPage());

page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) {
    console.log("NAV", page.url(), "|", page.title().catch(() => ""));
  }
});

await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch((error) => {
  console.warn("Could not open SWS:", error.message);
});

console.log("Waiting for manual sign-in. Press Ctrl+C here to close the browser.");

// Keep a cookie snapshot for the unattended daily timer. Only save after the
// SWS home page is visible, so opening the login page cannot erase a valid snapshot.
async function exportState() {
  const url = page.url();
  if (/my\.policy|vdesk\/hangup|chrome:\/\//.test(url)) return;
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/Online Timetable|View room timetables/i.test(body)) return;
  const state = await context.storageState();
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.chmodSync(statePath, 0o600);
  console.log(`Saved SWS session snapshot (${state.cookies.length} cookies)`);
}
setInterval(() => exportState().catch(() => {}), 30000);
exportState().catch(() => {});

const shutdown = async () => {
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the process/browser alive until the user closes the window or Ctrl+C.
await new Promise(() => {});
