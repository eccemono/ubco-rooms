#!/usr/bin/env node
/** Export cookies from the interactive collector browser at localhost:9222. */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) || "9222";
const out = process.argv.find((a) => a.startsWith("--output="))?.slice(9) ||
  path.join(import.meta.dirname, ".sws-storage-state.json");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
if (!context) throw new Error("No browser context on port " + port);
const state = await context.storageState();
fs.writeFileSync(out, JSON.stringify(state));
fs.chmodSync(out, 0o600);
console.log(`Wrote ${out} (${state.cookies.length} cookies)`);
await browser.close();
