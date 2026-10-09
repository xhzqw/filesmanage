#!/usr/bin/env node
// Client performance gate (UX-ACCEPTANCE-v1 §7 PERF-01..PERF-08, §9
// scripts/ux_perf_check.mjs, §1.2 evidence type P; DESKTOP-INTERACTION-v1 §9
// candidate latency budgets): fixed-client latency measurements taken through
// the real UI in headless Chrome over CDP, plus the main-thread long-task /
// CPU / memory record the contract asks a P-evidence item to carry.
//
// HONESTY CONTRACT — read this before trusting any number below.
//
//  1. Scale. The dev instance does NOT carry the contract's pressure scale
//     (10k folders / 100k files / 400k versions) and has no CAD scene, so this
//     gate measures the scale it actually has. It builds its own isolated,
//     timestamped fixture through the real API — a 3-level, 61-folder subtree
//     (1 + 6 + 54), a 200-file folder paged 50 rows at a time, two small swap
//     folders and one upload target — prints the measured dataset shape and the
//     exact Chrome build in the summary, and removes the whole fixture again
//     (folders -> trash -> purge) even after a mid-run crash.
//
//  2. Numbers. Every MEASURE line is a real p50/p95 in milliseconds measured on
//     this client against that fixture. The percentile uses the same nearest-
//     rank formula as scripts/loadtest.py and scripts/pe12_cad_saturation.py.
//
//  3. Proposed thresholds are advisory. UX-ACCEPTANCE-v1 §7 states explicitly
//     that its targets are proposed, not measured. The threshold comparison is
//     therefore printed on an ADVISORY line and can NEVER fail a check. A check
//     FAILs only when a measurement is missing or the interaction is obviously
//     broken: no feedback at all (selection / menu / focus never changed),
//     duplicate rows across cursor pages, a stale response overwriting a newer
//     view, or the tree not rendering its fixture subset.
//
//  4. Scope. PERF-05 (100k files / 400k versions) and PERF-07 (CAD assembly
//     enter/leave cycles) need the full-scale dataset and the CAD scene; they
//     are printed as SKIP lines instead of being faked.
//
// Timing method per item (what the two timestamps are):
//   PERF-01  performance.now() before dispatching a synthetic row click ->
//            the polled moment the row's aria-selected reads "true"
//            (task-level poll on a MessageChannel task, so the number carries
//            one task-boundary of polling overhead instead of the ~4ms a nested
//            setTimeout chain would add), plus a second series to the next
//            rendered frame after that change.
//   PERF-02  the same pair around a synthetic contextmenu dispatch -> the
//            polled moment [role=menu] exists (plus next frame).
//   PERF-03  performance.now() before a synthetic ArrowDown keydown on the
//            focused treeitem -> the polled moment document.activeElement
//            reports a different data-folder-id.
//   PERF-04  performance.now() before clicking 加载更多 -> the polled moment
//            the row count grows (includes the cursor round trip; that is the
//            honest "append -> rows visible" number), plus next frame.
//   PERF-06  no latency verdict: the measured number is the wall time for 20
//            rapid in-app navigations to settle, and correctness is asserted
//            (final table matches the final folder, and still does after the
//            settle window).
//   PERF-08  PERF-03's pair, repeated while upload queue items are in flight;
//            the queue overlap in milliseconds is reported next to it.
//
// Usage: node scripts/ux_perf_check.mjs [--base http://127.0.0.1:18091]
//        [--password-file .secrets/admin.password] [--port 9363]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9363"));
const ORIGIN = BASE;

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

// ---- measured scale (what this environment actually has) ----
const TREE_L2 = 6;
const TREE_L3_PER_L2 = 9; // 1 + 6 + 54 = 61 folders, three levels
const FILES_FOLDER_FILES = 200;
const FILES_PAGE = 50; // FileTable's own cursor page size
const SWAP_A_FILES = 3;
const SWAP_B_FILES = 2;
const UPLOAD_FILES = 6; // six 2 MiB drops: a queue wide enough to still be in flight during the probe
const UPLOAD_FILE_BYTES = 2 * 1024 * 1024;
const VIEWPORT = "1440x900";

// ---- sample sizes (PERF-01/02 need >=30 per the gate request) ----
const PERF01_CLICKS = 30;
const PERF02_MENUS = 30;
const PERF03_STEPS = 40;
const PERF04_APPENDS = 2;
const PERF06_NAVIGATIONS = 20;
const PERF08_STEPS = 20;

// UX-ACCEPTANCE-v1 §7 / DESKTOP-INTERACTION-v1 §9 PROPOSED targets. These are
// candidate numbers, never measured contract results: they only ever reach an
// ADVISORY line. PERF-03 and PERF-08 reuse the §9 local-feedback candidate
// because the contract gives them no number of their own.
const PROPOSED = { PERF01: 50, PERF02: 100, PERF03: 50, PERF08: 50 };

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

const measurements = [];
const fmt = (value) => (Number.isFinite(value) ? value.toFixed(1) : "n/a");
// Nearest-rank percentile, identical to scripts/loadtest.py / pe12_cad_saturation.py.
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

// One measurement series: prints the samples, the p50/p95 and — when the
// contract proposes a target — an advisory comparison that never fails a check.
function measure(id, label, values, options = {}) {
  const proposedMs = options.proposedMs ?? null;
  const samples = values.filter((v) => Number.isFinite(v));
  if (samples.length === 0) {
    console.log(`MEASURE ${id} ${label} n=0 (no samples)`);
    measurements.push({ id, label, n: 0, p50: null, p95: null, proposedMs, note: options.note ?? "" });
    return { n: 0, p50: null, p95: null };
  }
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const note = options.note ? ` :: ${options.note}` : "";
  console.log(`MEASURE ${id} ${label} n=${samples.length} p50=${fmt(p50)}ms p95=${fmt(p95)}ms min=${fmt(min)}ms max=${fmt(max)}ms${note}`);
  console.log(`SAMPLES ${id} ${label} [${samples.map((v) => v.toFixed(1)).join(", ")}]`);
  measurements.push({ id, label, n: samples.length, p50, p95, min, max, proposedMs, note: options.note ?? "" });
  if (proposedMs !== null) {
    console.log(`ADVISORY ${id} ${label}: p95 ${fmt(p95)}ms vs proposed ${proposedMs}ms `
      + `(${p95 <= proposedMs ? "within" : "over"}; proposed candidate target, advisory only - not a FAIL condition)`);
  }
  return { n: samples.length, p50, p95 };
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 1; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, options = {}) {
    const params = { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: options.includeCommandLineAPI === true };
    const res = await this.send("Runtime.evaluate", params);
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 250) + " EXPR=" + expression.slice(0, 160));
    return res.result.value;
  }
  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const timer = setInterval(() => {
        const hit = this.events.find((e) => e.method === "Page.loadEventFired");
        if (hit) { this.events.splice(this.events.indexOf(hit), 1); clearInterval(timer); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await delay(1000);
  }
  async waitFor(predicate, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(`(${predicate})()`);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await delay(250);
    }
  }
  async key(key, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  async login() {
    await this.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录');
      btn?.click();return true;})()`);
    return this.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 20000);
  }
  close() { this.ws.close(); }
}

// In-page instrumentation installed into every new document. It must be read by
// the measurement loops, which run entirely in the page so the numbers never
// include a CDP round trip.
const PAGE_HELPERS = `(() => {
  if (window.__uxperf) return;
  const long = [];
  window.__uxperfLongUnsupported = null;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    window.__uxperfLongUnsupported = String(error && error.message ? error.message : error);
  }
  window.__uxperf = {
    now: () => performance.now(),
    // Task-level poll: each probe yields as a real task, so React's post-commit
    // effects (which its scheduler runs in a macrotask) are observed instead of
    // starved. The yield is a MessageChannel task, not setTimeout(0): Chrome
    // clamps nested timers to ~4ms, which would quantise every sample; a channel
    // task keeps the poll cadence at one task boundary (~0.1-1ms).
    async poll(predicate, timeoutMs) {
      const channel = new MessageChannel();
      const waiters = [];
      channel.port1.onmessage = () => { const resolve = waiters.shift(); if (resolve) resolve(); };
      const tick = () => new Promise((resolve) => { waiters.push(resolve); channel.port2.postMessage(0); });
      const deadline = performance.now() + (timeoutMs || 3000);
      try {
        for (;;) {
          let hit = false;
          try { hit = predicate(); } catch (error) { hit = false; }
          if (hit) return { ok: true, at: performance.now() };
          if (performance.now() >= deadline) return { ok: false, at: performance.now() };
          await tick();
        }
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    },
    // Next rendered frame; null when the headless session never delivers one
    // (reported as a stalled frame instead of being invented).
    frame(timeoutMs) {
      const limit = timeoutMs || 250;
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, limit);
        requestAnimationFrame((t) => { if (!done) { done = true; clearTimeout(timer); resolve(t); } });
      });
    },
    longTasks() { return long.map((entry) => ({ start: entry.start, duration: entry.duration })); },
    clearLongTasks() { long.length = 0; },
  };
})();`;

async function ensureHelpers(cdp) {
  const present = await cdp.evaluate(`Boolean(window.__uxperf)`);
  if (!present) await cdp.evaluate(PAGE_HELPERS);
}

function metricMap(res) {
  const map = {};
  for (const metric of res.metrics ?? []) map[metric.name] = metric.value;
  return map;
}

// Open/close a measurement window: main-thread long tasks (PerformanceObserver
// in the page) plus the CPU/memory counters from Performance.getMetrics.
async function openWindow(cdp, label) {
  await cdp.evaluate(`window.__uxperf && window.__uxperf.clearLongTasks()`);
  const before = metricMap(await cdp.send("Performance.getMetrics"));
  return { label, before };
}

async function closeWindow(cdp, window_) {
  const after = metricMap(await cdp.send("Performance.getMetrics"));
  const tasks = await cdp.evaluate(`window.__uxperf ? window.__uxperf.longTasks() : []`);
  const unsupported = await cdp.evaluate(`window.__uxperfLongUnsupported`);
  const total = tasks.reduce((n, entry) => n + entry.duration, 0);
  const max = tasks.reduce((n, entry) => Math.max(n, entry.duration), 0);
  const delta = (name) => (after[name] ?? 0) - (window_.before[name] ?? 0);
  const heapDelta = delta("JSHeapUsedSize") / 1048576;
  console.log(`WINDOW ${window_.label} longtasks=${tasks.length} longtaskTotal=${fmt(total)}ms longtaskMax=${fmt(max)}ms `
    + `cpuTask=${fmt(delta("TaskDuration") * 1000)}ms cpuScript=${fmt(delta("ScriptDuration") * 1000)}ms `
    + `layout=${fmt(delta("LayoutDuration") * 1000)}ms heapDelta=${fmt(heapDelta)}MB`
    + (unsupported ? ` (longtask observer unsupported: ${unsupported})` : ""));
  return { tasks, total, max, heapDelta };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------- fixture API (same shape as the sibling UX gates) ----------------
let sessionCookie = "";

async function json(method, path, body) {
  const headers = { Origin: ORIGIN, Cookie: sessionCookie };
  let data;
  if (body !== undefined) {
    data = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, { method, headers, body: data });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function uploadFixture(folderId, name, content) {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", `ux-perf-${stamp}-${name}`);
    const res = await fetch(`${BASE}/api/files`, {
      method: "POST", headers: { Origin: ORIGIN, Cookie: sessionCookie }, body: form,
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok && body.data?.fileId) return body.data;
    last = `${res.status} ${JSON.stringify(body)}`;
    if (attempt < 2) await delay(300);
  }
  throw new Error(`fixture upload ${name} failed: ${last}`);
}

// Page the fixture folder through the cursor API exactly as the UI does, so the
// fixture's own scale claim (200 rows, no duplicate ids) is verified server-side.
async function listAll(folderId, sort = "updated_desc") {
  const items = [];
  let cursor = "";
  for (let page = 0; page < 40; page++) {
    const query = `/api/files?folder=${folderId}&sort=${sort}&limit=${FILES_PAGE}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await json("GET", query);
    if (res.status !== 200) throw new Error(`fixture list failed: ${res.status} ${JSON.stringify(res.body)}`);
    items.push(...(res.body?.data?.items ?? []));
    cursor = res.body?.data?.nextCursor ?? "";
    if (!cursor) break;
  }
  return items;
}

async function purgeTrashByStamp() {
  for (let pass = 0; pass < 3; pass++) {
    const trash = await json("GET", "/api/trash");
    const entries = (trash.body?.data ?? []).filter((entry) => {
      const name = String(entry.name ?? entry.oldName ?? "");
      return name.includes(stamp) && name.includes("UX-PERF");
    });
    if (entries.length === 0) return;
    for (const entry of entries) await json("DELETE", "/api/trash/" + entry.id);
  }
}

// Always runs, also after a crashed suite: folders -> trash -> purge.
async function cleanupFixture(fixture) {
  const errors = [];
  const attempt = async (fn) => { try { await fn(); } catch (err) { errors.push(String(err?.message ?? err)); } };
  await attempt(async () => {
    const targets = fixture.roots?.length ? fixture.roots : fixture.created;
    for (const id of [...targets].reverse()) {
      if (id) await json("DELETE", `/api/folders/${id}`);
    }
  });
  await attempt(purgeTrashByStamp);
  return errors;
}

// Fills the caller-owned fixture record, so a failure halfway through still
// leaves every created folder id behind for the unconditional cleanup.
async function createFixture(fixture) {
  const mk = async (name, parentId) => {
    const res = await json("POST", "/api/folders", { name, parentId });
    if (res.status !== 201 || !res.body?.data?.id) {
      throw new Error(`fixture folder create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    fixture.created.push(res.body.data.id);
    // A folder created directly under the visible root is a fixture root: the
    // server soft-deletes a whole subtree in one transaction, so cleanup only
    // has to remove these five and let the cascade take the rest.
    if (parentId === rootId) fixture.roots.push(res.body.data.id);
    return res.body.data.id;
  };

  // 3-level subtree: 1 + TREE_L2 + TREE_L2*TREE_L3_PER_L2 folders.
  fixture.treeL1 = await mk(`UX-PERF-TREE-${stamp}`, rootId);
  fixture.subtreeIds.push(fixture.treeL1);
  for (let c = 1; c <= TREE_L2; c++) {
    const label = String(c).padStart(2, "0");
    const l2 = await mk(`UX-PERF-TREE-${stamp}-c${label}`, fixture.treeL1);
    fixture.subtreeIds.push(l2);
    for (let g = 1; g <= TREE_L3_PER_L2; g++) {
      const leaf = await mk(`UX-PERF-TREE-${stamp}-c${label}-g${String(g).padStart(2, "0")}`, l2);
      fixture.subtreeIds.push(leaf);
    }
  }

  // 200-file folder, paged 50 rows at a time by FileTable.
  fixture.files = await mk(`UX-PERF-FILES-${stamp}`, rootId);
  const fileNames = Array.from({ length: FILES_FOLDER_FILES },
    (_, i) => `pf-${stamp}-${String(i + 1).padStart(4, "0")}.txt`);
  await mapLimit(fileNames, 4, (name, index) => uploadFixture(fixture.files, name, `perf fixture ${stamp} row ${index + 1}\n`));
  const listed = await listAll(fixture.files);
  const listedIds = new Set(listed.map((item) => item.id));
  if (listed.length !== FILES_FOLDER_FILES || listedIds.size !== FILES_FOLDER_FILES) {
    throw new Error(`fixture folder did not verify: rows=${listed.length} unique=${listedIds.size} expected=${FILES_FOLDER_FILES}`);
  }
  const listedNames = listed.map((item) => item.name).sort();
  const expectedNames = [...fileNames].sort();
  if (listedNames.join("|") !== expectedNames.join("|")) {
    throw new Error("fixture folder names do not match the created set");
  }

  // Two small swap folders for the rapid-switching fault injection.
  fixture.swapA = await mk(`UX-PERF-SWAP-A-${stamp}`, rootId);
  fixture.swapB = await mk(`UX-PERF-SWAP-B-${stamp}`, rootId);
  for (let i = 1; i <= SWAP_A_FILES; i++) await uploadFixture(fixture.swapA, `swa-${stamp}-${i}.txt`, `swap a ${i} ${stamp}\n`);
  for (let i = 1; i <= SWAP_B_FILES; i++) await uploadFixture(fixture.swapB, `swb-${stamp}-${i}.txt`, `swap b ${i} ${stamp}\n`);

  // Upload target for the bounded PERF-08 queue probe (files land here only).
  fixture.upload = await mk(`UX-PERF-UPLOAD-${stamp}`, rootId);

  fixture.names = {
    tree: `UX-PERF-TREE-${stamp}`,
    files: `UX-PERF-FILES-${stamp}`,
    swapA: [...Array(SWAP_A_FILES).keys()].map((i) => `swa-${stamp}-${i + 1}.txt`).sort(),
    swapB: [...Array(SWAP_B_FILES).keys()].map((i) => `swb-${stamp}-${i + 1}.txt`).sort(),
    upload: [...Array(UPLOAD_FILES).keys()].map((i) => `up-${stamp}-${String(i + 1).padStart(2, "0")}.bin`).sort(),
  };
  return fixture;
}

// The tree only renders descendants of its expanded nodes, and its expanded
// state is private. This expands the visible root (the fixture's parent) so the
// fixture folders exist as treeitems before any suite queries them.
async function ensureTreeFolderRendered(cdp, folderId) {
  return await cdp.evaluate(`(async () => {
    const find = (id) => document.querySelector('li[data-folder-id="' + id + '"]');
    const root = find(${JSON.stringify(rootId)});
    if (root && root.getAttribute("aria-expanded") === "false") {
      const button = root.querySelector(".tree-row button");
      if (button) { button.click(); await new Promise((resolve) => setTimeout(resolve, 150)); }
    }
    return find(${JSON.stringify(folderId)}) !== null;
  })()`);
}

// Expands the whole fixture subtree through its own chevrons, so a keyboard
// walk really has the 61 fixture nodes in the visible order (the tree owns its
// expanded state; nothing here is faked).
async function expandFixtureSubtree(cdp) {
  const clicks = await cdp.evaluate(`(async () => {
    const ids = ${JSON.stringify(currentFixture.subtreeIds)};
    let clicked = 0;
    for (const id of ids) {
      const li = document.querySelector('li[data-folder-id="' + id + '"]');
      const button = li ? li.querySelector(".tree-row button") : null;
      if (button && li.getAttribute("aria-expanded") === "false") {
        button.click();
        clicked++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return clicked;
  })()`);
  await delay(500);
  const rendered = await cdp.evaluate(`(()=>{
    const ids = ${JSON.stringify(currentFixture.subtreeIds)};
    return {
      rendered: ids.filter((id) => document.querySelector('li[data-folder-id="' + id + '"]') !== null).length,
      expected: ids.length,
    };
  })()`);
  return { clicks, ...rendered };
}

// ================= PERF-01: file-row single-click selection feedback =================
async function perf01Suite(cdp) {
  await ensureHelpers(cdp);
  await cdp.navigate(`${BASE}/doc?folder=${currentFixture.files}`);
  const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=${FILES_PAGE}`, 20000);
  check("PERF-01 200-file folder lists its first 50-row page", Boolean(rowsReady), String(rowsReady));
  await delay(400);

  const window_ = await openWindow(cdp, "PERF-01 selection");
  const res = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const rowsOf = () => Array.from(document.querySelectorAll("tbody tr[data-id]"));
    const clicks = ${PERF01_CLICKS};
    const commit = [], frame = [];
    let missed = 0, startsSelected = 0, stalledFrames = 0;
    if (rowsOf().length < 4) return { error: "fewer than 4 file rows rendered", rows: rowsOf().length };
    const pick = Math.min(8, rowsOf().length);
    for (let i = 0; i < clicks; i++) {
      const row = rowsOf()[i % pick];
      if (!row) { missed++; continue; }
      const id = row.getAttribute("data-id");
      if (row.getAttribute("aria-selected") === "true") startsSelected++;
      const t0 = P.now();
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const hit = await P.poll(() => {
        const now = rowsOf().find((r) => r.getAttribute("data-id") === id);
        return Boolean(now) && now.getAttribute("aria-selected") === "true";
      }, 3000);
      if (!hit.ok) { missed++; continue; }
      commit.push(hit.at - t0);
      const painted = await P.frame();
      if (painted === null) stalledFrames++; else frame.push(painted - t0);
    }
    return { commit, frame, missed, startsSelected, stalledFrames, rows: rowsOf().length };
  })()`);
  await closeWindow(cdp, window_);

  if (!res || res.error) {
    check("PERF-01 single-click selection produced samples", false, JSON.stringify(res));
    return;
  }
  check(`PERF-01 every click produced selection feedback (${PERF01_CLICKS} clicks, ${res.missed} missing)`,
    res.missed === 0 && res.commit.length === PERF01_CLICKS && res.startsSelected === 0,
    JSON.stringify({ missed: res.missed, samples: res.commit.length, startsSelected: res.startsSelected, rows: res.rows }));
  measure("PERF-01", "click->aria-selected", res.commit, { proposedMs: PROPOSED.PERF01 });
  measure("PERF-01", "click->next-frame", res.frame,
    { proposedMs: PROPOSED.PERF01, note: `rendered-frame series; stalled frames=${res.stalledFrames}` });
}

// ================= PERF-02: already-computable context menu =================
async function perf02Suite(cdp) {
  await ensureHelpers(cdp);
  await cdp.navigate(`${BASE}/doc?folder=${currentFixture.files}`);
  const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=4`, 20000);
  check("PERF-02 row context menu measurable on the file page", Boolean(rowsReady), String(rowsReady));
  await delay(400);

  const window_ = await openWindow(cdp, "PERF-02 menu");
  const res = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const rowsOf = () => Array.from(document.querySelectorAll("tbody tr[data-id]"));
    const menuOf = () => document.querySelector('[role="menu"]');
    const menus = ${PERF02_MENUS};
    const commit = [], frame = [];
    let missed = 0, stuck = 0, emptyMenus = 0, stalledFrames = 0, seenItems = null;
    if (rowsOf().length < 4) return { error: "fewer than 4 file rows rendered", rows: rowsOf().length };
    const pick = Math.min(6, rowsOf().length);
    for (let i = 0; i < menus; i++) {
      const row = rowsOf()[i % pick];
      if (!row) { missed++; continue; }
      const t0 = P.now();
      row.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 120 + (i % 5) * 12, clientY: 140 + (i % 7) * 9,
      }));
      const hit = await P.poll(() => Boolean(menuOf()), 3000);
      if (!hit.ok) { missed++; continue; }
      commit.push(hit.at - t0);
      const painted = await P.frame();
      if (painted === null) stalledFrames++; else frame.push(painted - t0);
      const menu = menuOf();
      const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => (b.textContent || "").trim()) : [];
      if (items.length === 0) emptyMenus++;
      seenItems = items;
      // Close through the menu's own keyboard contract, then confirm it is gone:
      // an unclosed menu would silently turn the next sample into a no-op.
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      const closed = await P.poll(() => !menuOf(), 3000);
      if (!closed.ok) { stuck++; break; }
    }
    return { commit, frame, missed, stuck, emptyMenus, stalledFrames, seenItems };
  })()`);
  await closeWindow(cdp, window_);

  if (!res || res.error) {
    check("PERF-02 context-menu feedback produced samples", false, JSON.stringify(res));
    return;
  }
  check(`PERF-02 menu appeared for every right-click (${PERF02_MENUS} dispatches, ${res.missed} missing)`,
    res.missed === 0 && res.commit.length === PERF02_MENUS && res.emptyMenus === 0,
    JSON.stringify({ missed: res.missed, samples: res.commit.length, emptyMenus: res.emptyMenus, items: res.seenItems }));
  check("PERF-02 menu closed again after every sample", res.stuck === 0, JSON.stringify({ stuck: res.stuck }));
  measure("PERF-02", "contextmenu->role=menu", res.commit, { proposedMs: PROPOSED.PERF02 });
  measure("PERF-02", "contextmenu->next-frame", res.frame,
    { proposedMs: PROPOSED.PERF02, note: `rendered-frame series; stalled frames=${res.stalledFrames}` });
}

// ================= PERF-03: directory tree keyboard roaming =================
async function perf03Suite(cdp) {
  await ensureHelpers(cdp);
  await cdp.navigate(`${BASE}/doc?folder=${currentFixture.treeL1}`);
  await ensureTreeFolderRendered(cdp, currentFixture.treeL1);
  const treeReady = await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${currentFixture.treeL1}"]')!==null`, 20000);
  check("PERF-03 fixture subtree rendered in the tree", Boolean(treeReady), String(treeReady));

  // Expand the fixture subtree through its own chevrons so the roaming really
  // walks the 61 nodes (the tree owns its expanded state; nothing else is faked).
  const expanded = await expandFixtureSubtree(cdp);
  check("PERF-03 the whole 61-folder subtree is rendered after expansion",
    expanded.rendered === expanded.expected, JSON.stringify(expanded));

  const window_ = await openWindow(cdp, "PERF-03 tree roaming");
  const res = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const items = () => Array.from(document.querySelectorAll('li[role="treeitem"]'));
    const activeId = () => { const el = document.activeElement; return el && el.getAttribute ? el.getAttribute("data-folder-id") : null; };
    const startId = ${JSON.stringify(currentFixture.treeL1)};
    const steps = ${PERF03_STEPS};
    const start = items().find((li) => li.getAttribute("data-folder-id") === startId);
    if (!start) return { error: "fixture folder is not a rendered treeitem" };
    const visibleIndex = items().indexOf(start);
    const following = items().length - visibleIndex - 1;
    if (following < steps) {
      return { error: "not enough visible treeitems after the fixture folder for " + steps + " steps", following, visible: items().length };
    }
    start.focus();
    await P.frame();
    if (activeId() !== startId) return { error: "focus did not land on the fixture folder", active: activeId() };
    const samples = [], visited = [];
    let missed = 0;
    for (let i = 0; i < steps; i++) {
      const before = activeId();
      const el = document.activeElement;
      const t0 = P.now();
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true,
      }));
      const hit = await P.poll(() => activeId() !== null && activeId() !== before, 3000);
      if (!hit.ok) { missed++; break; }
      samples.push(hit.at - t0);
      visited.push(activeId());
    }
    const list = items();
    const treeRoot = document.querySelector('ul[role="tree"]');
    return {
      samples, visited, missed,
      treeitems: list.length,
      treeNodes: treeRoot ? treeRoot.querySelectorAll("*").length : 0,
      documentNodes: document.querySelectorAll("*").length,
    };
  })()`);
  await closeWindow(cdp, window_);

  if (!res || res.error) {
    check("PERF-03 keyboard roaming produced samples", false, JSON.stringify(res));
    return;
  }
  check(`PERF-03 every ArrowDown moved focus (${PERF03_STEPS} steps, ${res.missed} missing)`,
    res.missed === 0 && res.samples.length === PERF03_STEPS,
    JSON.stringify({ missed: res.missed, samples: res.samples.length, treeitems: res.treeitems }));
  const subtree = new Set(currentFixture.subtreeIds);
  const inside = res.visited.filter((id) => subtree.has(id)).length;
  check("PERF-03 the roaming sample stayed inside the 61-folder fixture subtree",
    inside === res.visited.length,
    JSON.stringify({ visited: res.visited.length, insideSubtree: inside, distinct: new Set(res.visited).size }));
  measure("PERF-03", "ArrowDown->focus moved", res.samples, { proposedMs: PROPOSED.PERF03 });

  // DOM node count: a quadratic render would blow the per-treeitem ratio up.
  const perItem = res.treeitems > 0 ? res.treeNodes / res.treeitems : 0;
  console.log(`METRIC PERF-03 treeitems=${res.treeitems} treeNodes=${res.treeNodes} documentNodes=${res.documentNodes} nodesPerTreeitem=${fmt(perItem)}`);
  console.log(`ADVISORY PERF-03 tree DOM shape: ${fmt(perItem)} nodes per treeitem vs report-only bound 25 `
    + `(${perItem <= 25 ? "within" : "over"}; the tree renders one row per visible node, so a quadratic or duplicated render would show here)`);
}

// ================= PERF-04: cursor paging in the 200-file folder =================
async function perf04Suite(cdp) {
  await ensureHelpers(cdp);
  await cdp.navigate(`${BASE}/doc?folder=${currentFixture.files}`);
  const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=${FILES_PAGE}`, 20000);
  check("PERF-04 first cursor page loaded (50 rows)", Boolean(rowsReady), String(rowsReady));
  await delay(400);

  const window_ = await openWindow(cdp, "PERF-04 paging");
  const res = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const rowsOf = () => Array.from(document.querySelectorAll("tbody tr[data-id]"));
    const moreButton = () => Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "加载更多");
    const appends = ${PERF04_APPENDS};
    const samples = [], frame = [], counts = [];
    let missed = 0, missing = 0, stalledFrames = 0;
    for (let i = 0; i < appends; i++) {
      const button = moreButton();
      if (!button || button.disabled) { missing++; break; }
      const before = rowsOf().length;
      const t0 = P.now();
      button.click();
      const hit = await P.poll(() => rowsOf().length > before, 20000);
      if (!hit.ok) { missed++; break; }
      samples.push(hit.at - t0);
      const painted = await P.frame();
      if (painted === null) stalledFrames++; else frame.push(painted - t0);
      counts.push(rowsOf().length);
    }
    const ids = rowsOf().map((row) => row.getAttribute("data-id"));
    const seen = new Set(), duplicates = [];
    for (const id of ids) { if (seen.has(id)) duplicates.push(id); else seen.add(id); }
    return { samples, frame, counts, missed, missing, stalledFrames, rows: ids.length, duplicates, moreLeft: Boolean(moreButton()) };
  })()`);
  await closeWindow(cdp, window_);

  if (!res || res.error) {
    check("PERF-04 cursor paging produced samples", false, JSON.stringify(res));
    return;
  }
  const expectedRows = FILES_PAGE * (PERF04_APPENDS + 1);
  check(`PERF-04 two 加载更多 clicks appended to ${expectedRows} unique rows`,
    res.missed === 0 && res.missing === 0 && res.rows === expectedRows && res.duplicates.length === 0
    && res.counts[0] === FILES_PAGE * 2,
    JSON.stringify({ counts: res.counts, rows: res.rows, duplicates: res.duplicates.slice(0, 5), missed: res.missed, missing: res.missing, moreLeft: res.moreLeft }));
  measure("PERF-04", "click->appended rows in DOM", res.samples, { note: "includes the cursor round trip; no contract threshold" });
  measure("PERF-04", "click->appended rows on a frame", res.frame,
    { note: `rendered-frame series; stalled frames=${res.stalledFrames}; no contract threshold` });

  // Interaction stays stable on the appended region: one click, one selection.
  const stability = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const rowsOf = () => Array.from(document.querySelectorAll("tbody tr[data-id]"));
    const rows = rowsOf();
    const target = rows[Math.min(${FILES_PAGE} + 5, rows.length - 1)];
    if (!target) return { error: "no appended row to select" };
    const id = target.getAttribute("data-id");
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const hit = await P.poll(() => {
      const row = rowsOf().find((r) => r.getAttribute("data-id") === id);
      return Boolean(row) && row.getAttribute("aria-selected") === "true";
    }, 3000);
    const selected = rowsOf().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.getAttribute("data-id"));
    return { id, hit: hit.ok, selected: selected.length, correct: selected.length === 1 && selected[0] === id };
  })()`);
  check("PERF-04 a row appended by paging selects cleanly", stability?.correct === true, JSON.stringify(stability));

  // Report-only probe: two clicks in the same task. The contract asks the UI to
  // serialise loadMore, so a duplicate/lost page here is a finding to report —
  // deliberately not a FAIL, because this gate's PERF-04 assertion is the
  // sequential click path above.
  const rapid = await cdp.evaluate(`(async () => {
    const rowsOf = () => Array.from(document.querySelectorAll("tbody tr[data-id]"));
    const button = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "加载更多");
    if (!button) return { skipped: "no 加载更多 button left" };
    const before = rowsOf().length;
    button.click(); button.click();
    await new Promise((r) => setTimeout(r, 2500));
    const ids = rowsOf().map((row) => row.getAttribute("data-id"));
    const seen = new Set(), duplicates = [];
    for (const id of ids) { if (seen.has(id)) duplicates.push(id); else seen.add(id); }
    return { before, after: ids.length, appended: ids.length - before, duplicates: duplicates.length };
  })()`);
  console.log(`PROBE PERF-04 rapid double append: ${JSON.stringify(rapid)} (report only; not asserted by this gate)`);
}

// ================= PERF-06: rapid folder switching =================
async function listenerCount(cdp) {
  try {
    return await cdp.evaluate(`(() => {
      if (typeof getEventListeners !== "function") return { unavailable: true };
      const count = (el) => Object.values(getEventListeners(el)).reduce((n, list) => n + list.length, 0);
      return { document: count(document), window: count(window) };
    })()`, { includeCommandLineAPI: true });
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function perf06Suite(cdp) {
  await ensureHelpers(cdp);
  const { swapA, swapB, names } = currentFixture;
  await cdp.navigate(`${BASE}/doc?folder=${swapA}`);
  await ensureTreeFolderRendered(cdp, swapA);
  const ready = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=${SWAP_A_FILES}`, 20000);
  check("PERF-06 swap folder A loaded before the rapid switching", Boolean(ready), String(ready));
  await delay(600);

  const before = await cdp.evaluate(`(()=>({nodes: document.querySelectorAll("*").length, rows: document.querySelectorAll("tbody tr[data-id]").length}))()`);
  const listenersBefore = await listenerCount(cdp);
  const window_ = await openWindow(cdp, "PERF-06 rapid switching");

  const nav = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const a = ${JSON.stringify(swapA)}, b = ${JSON.stringify(swapB)};
    const total = ${PERF06_NAVIGATIONS};
    let dispatched = 0, linkMissing = 0;
    const t0 = P.now();
    for (let i = 0; i < total; i++) {
      const id = i % 2 === 0 ? a : b;
      const link = document.querySelector('li[data-folder-id="' + id + '"] a');
      if (!link) { linkMissing++; break; }
      link.click();
      dispatched++;
      await new Promise((r) => setTimeout(r, 15));
    }
    return { dispatched, linkMissing, elapsed: P.now() - t0 };
  })()`);
  check(`PERF-06 ${PERF06_NAVIGATIONS} rapid in-app folder switches dispatched`,
    nav?.dispatched === PERF06_NAVIGATIONS && nav?.linkMissing === 0, JSON.stringify(nav));

  const finalId = (PERF06_NAVIGATIONS - 1) % 2 === 0 ? swapA : swapB;
  const finalNames = ((PERF06_NAVIGATIONS - 1) % 2 === 0 ? names.swapA : names.swapB).join("|");
  const expectFinal = `(()=>{
    const current = document.querySelector('li[role="treeitem"][aria-current="page"]');
    if (!current || current.getAttribute("data-folder-id") !== ${JSON.stringify(finalId)}) return false;
    const names = Array.from(document.querySelectorAll("tbody tr[data-id] .file-name")).map((el) => el.textContent);
    return names.sort().join("|") === ${JSON.stringify(finalNames)};
  })()`;
  const settleStart = Date.now();
  const settled = await cdp.waitFor(`()=>${expectFinal}`, 25000);
  const settleMs = Date.now() - settleStart;
  check("PERF-06 the final table matches the final folder",
    Boolean(settled), JSON.stringify({ finalFolder: finalId, expected: finalNames, settled }));
  console.log(`METRIC PERF-06 ${PERF06_NAVIGATIONS} rapid navigations dispatched in ${fmt(nav?.elapsed)}ms; final view matched ${fmt(settleMs)}ms after the last click (report only, no contract threshold)`);

  // The real stale-response test: a late answer for an already-abandoned folder
  // must not overwrite the view a moment later, so re-verify after a settle gap.
  await delay(1200);
  const stillMatches = await cdp.evaluate(expectFinal);
  const staleRows = await cdp.evaluate(`(()=>{
    const names = Array.from(document.querySelectorAll("tbody tr[data-id] .file-name")).map((el) => el.textContent).sort();
    return { names, current: document.querySelector('li[role="treeitem"][aria-current="page"]')?.getAttribute("data-folder-id") || null };
  })()`);
  check("PERF-06 no stale response overwrote the final folder after settling",
    stillMatches === true, JSON.stringify(staleRows));

  const after = await cdp.evaluate(`(()=>({nodes: document.querySelectorAll("*").length, rows: document.querySelectorAll("tbody tr[data-id]").length}))()`);
  const listenersAfter = await listenerCount(cdp);
  await closeWindow(cdp, window_);
  const margin = Math.max(400, Math.round((before?.nodes ?? 0) * 0.25));
  check("PERF-06 DOM nodes did not grow unboundedly across the switches",
    Number.isFinite(after?.nodes) && after.nodes <= (before?.nodes ?? 0) + margin,
    JSON.stringify({ before, after, margin }));
  console.log(`METRIC PERF-06 DOM nodes before=${before?.nodes} after=${after?.nodes} rows=${after?.rows} `
    + `listenersBefore=${JSON.stringify(listenersBefore)} listenersAfter=${JSON.stringify(listenersAfter)} (listener counts best-effort via CDP getEventListeners)`);
}

// ================= PERF-08 (bounded): tree navigation while uploads are in flight =================
async function perf08Suite(cdp) {
  await ensureHelpers(cdp);
  const fixture = currentFixture;
  await cdp.navigate(`${BASE}/doc?folder=${fixture.upload}`);
  await ensureTreeFolderRendered(cdp, fixture.upload);
  const zoneReady = await cdp.waitFor(`()=>document.querySelector('.dropzone')!==null`, 20000);
  check("PERF-08 upload target page ready", Boolean(zoneReady), String(zoneReady));
  await delay(400);

  // The tree must actually offer a place to roam to: expand the fixture subtree
  // up front (a fresh page load collapses it) so the keyboard probe can start
  // the moment the queue is live instead of spending the in-flight window on
  // expansion, and so the walk cannot bump into the end of the visible list.
  const expanded = await expandFixtureSubtree(cdp);
  check("PERF-08 the fixture subtree is expanded for the navigation probe",
    expanded.rendered === expanded.expected, JSON.stringify(expanded));

  const dropped = await cdp.evaluate(`(() => {
    const zone = document.querySelector(".dropzone");
    if (!zone) return { error: "no .dropzone" };
    const data = new DataTransfer();
    for (let i = 1; i <= ${UPLOAD_FILES}; i++) {
      data.items.add(new File([new Uint8Array(${UPLOAD_FILE_BYTES})],
        "up-${stamp}-" + String(i).padStart(2, "0") + ".bin", { type: "application/octet-stream" }));
    }
    zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    return { items: document.querySelectorAll(".upload-item").length };
  })()`);
  const queueSeen = await cdp.waitFor(`()=>document.querySelectorAll('.upload-item').length>=${UPLOAD_FILES}`, 20000);
  check(`PERF-08 the drop enqueues the ${UPLOAD_FILES}-file upload queue`, Boolean(queueSeen), JSON.stringify({ dropped, queue: queueSeen }));

  const window_ = await openWindow(cdp, "PERF-08 tree nav during upload");
  const res = await cdp.evaluate(`(async () => {
    const P = window.__uxperf;
    const activeId = () => { const el = document.activeElement; return el && el.getAttribute ? el.getAttribute("data-folder-id") : null; };
    const items = () => Array.from(document.querySelectorAll('li[role="treeitem"]'));
    const statuses = () => Array.from(document.querySelectorAll(".upload-item")).map((li) => (li.className || "").replace("upload-item", "").trim());
    const target = items().find((li) => li.getAttribute("data-folder-id") === ${JSON.stringify(fixture.treeL1)}) || items()[0];
    if (!target) return { error: "no treeitem available to focus" };
    const steps = ${PERF08_STEPS};
    const following = items().length - items().indexOf(target) - 1;
    if (following < steps) {
      return { error: "not enough visible treeitems after the focus target for " + steps + " steps", following, visible: items().length };
    }
    target.focus();
    await P.frame();
    if (activeId() !== target.getAttribute("data-folder-id")) {
      return { error: "focus did not land on the navigation start node", active: activeId() };
    }
    const samples = [], inflight = [];
    let missed = 0, inflightSteps = 0, overlapStart = null, overlapEnd = null;
    for (let i = 0; i < steps; i++) {
      const before = activeId();
      const el = document.activeElement;
      const t0 = P.now();
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true,
      }));
      const hit = await P.poll(() => activeId() !== null && activeId() !== before, 3000);
      if (!hit.ok) { missed++; break; }
      samples.push(hit.at - t0);
      const live = statuses().filter((s) => s === "uploading").length;
      inflight.push(live);
      if (live > 0) { inflightSteps++; if (overlapStart === null) overlapStart = P.now(); overlapEnd = P.now(); }
    }
    return {
      samples, missed, inflight, inflightSteps,
      overlapMs: overlapStart === null ? 0 : overlapEnd - overlapStart,
      queueAfterProbe: statuses(),
    };
  })()`);
  await closeWindow(cdp, window_);

  if (!res || res.error) {
    check("PERF-08 tree keyboard feedback produced samples", false, JSON.stringify(res));
    return;
  }
  check(`PERF-08 tree keyboard feedback still produced during the upload window (${PERF08_STEPS} steps, ${res.missed} missing)`,
    res.missed === 0 && res.samples.length === PERF08_STEPS,
    JSON.stringify({ missed: res.missed, samples: res.samples.length, inflight: res.inflight }));
  measure("PERF-08", "tree ArrowDown->focus moved during upload queue", res.samples,
    { proposedMs: PROPOSED.PERF08, note: `uploading item observed during ${res.inflightSteps}/${PERF08_STEPS} steps (overlap ${fmt(res.overlapMs)}ms)` });
  console.log(`NOTE PERF-08 upload-in-flight overlap: ${res.inflightSteps}/${PERF08_STEPS} steps, ${fmt(res.overlapMs)}ms total; `
    + `per-step in-flight item counts ${JSON.stringify(res.inflight)}; queue after probe ${JSON.stringify(res.queueAfterProbe)}; `
    + `measured feedback is reported either way and the bound is advisory`);

  const drained = await cdp.waitFor(`()=>{
    const items = Array.from(document.querySelectorAll(".upload-item"));
    return items.length > 0 && items.every((li) => !/(^| )queued|uploading/.test(li.className));
  }`, 60000);
  const finalStatuses = await cdp.evaluate(`(()=>Array.from(document.querySelectorAll(".upload-item")).map((li)=>({
    name: li.querySelector(".upload-item-name") ? li.querySelector(".upload-item-name").textContent : "",
    status: (li.className || "").replace("upload-item", "").trim(),
  })))()`);
  const committed = finalStatuses.filter((s) => s.status === "committed").length;
  const pending = finalStatuses.filter((s) => s.status === "queued" || s.status === "uploading").length;
  check("PERF-08 upload queue drained with no item still pending",
    Boolean(drained) && pending === 0, JSON.stringify(finalStatuses.map((s) => `${s.status}`)));
  check("PERF-08 committed uploads landed in the target folder",
    committed >= 1, JSON.stringify({ committed, total: finalStatuses.length }));
  const landed = await listAll(fixture.upload, "name_asc");
  check("PERF-08 the target folder holds exactly the committed uploads",
    landed.length === committed, JSON.stringify({ folderRows: landed.length, committed }));
}

// ================= orchestration =================
let rootId = "";
let currentFixture = null;

function printSummary(chromeInfo, cleanupErrors) {
  const fixture = currentFixture ?? { created: [] };
  console.log("---- summary ----");
  console.log(`DATASET fixture=UX-PERF-${stamp} scale=fixed-remote-dev scale-claim=measured-on-this-instance-only`);
  console.log(`DATASET subtree=${TREE_L2 * TREE_L3_PER_L2 + TREE_L2 + 1} folders (3 levels: 1 + ${TREE_L2} + ${TREE_L2 * TREE_L3_PER_L2})`
    + ` files-folder=${FILES_FOLDER_FILES} rows (cursor page ${FILES_PAGE})`
    + ` swap=${SWAP_A_FILES}+${SWAP_B_FILES} upload-target=${UPLOAD_FILES}x${UPLOAD_FILE_BYTES / 1048576}MiB`
    + ` fixture-folders=${fixture.created.length}`);
  console.log("DATASET created through /api/folders + multipart /api/files, verified by a cursor listing, removed in the cleanup phase");
  console.log(`CLIENT chrome=${chromeInfo?.product ?? "unknown"} js=${chromeInfo?.jsVersion ?? "unknown"} viewport=${VIEWPORT} deviceScaleFactor=1 headless=new`);
  if (chromeInfo?.userAgent) console.log(`CLIENT userAgent=${chromeInfo.userAgent}`);
  console.log("MEASUREMENTS (ms on this client against the dataset above):");
  if (measurements.length === 0) console.log("  (none recorded)");
  for (const m of measurements) {
    const advisory = m.proposedMs === null || m.proposedMs === undefined
      ? "advisory: none (the contract proposes no number for this interaction)"
      : `advisory: p95 ${fmt(m.p95)}ms vs proposed ${m.proposedMs}ms`;
    console.log(`  ${m.id} ${m.label} n=${m.n} p50=${fmt(m.p50)}ms p95=${fmt(m.p95)}ms :: ${advisory}`);
  }
  console.log("SKIP PERF-05/PERF-07 :: PERF-05/PERF-07 require the full-scale dataset / CAD scene; not measurable in this environment");
  console.log("SKIP PERF-05 :: the 100k files / 400k versions authorized isolated dataset (and the existing server-side budget gates) is not present on this dev instance");
  console.log("SKIP PERF-07 :: CAD assembly enter/leave cycles need the CAD scene, the three.js viewer and the conversion worker; out of scope for this gate");
  console.log("NOTE a FAIL in this gate means a measurement was missing or an interaction produced no feedback; the §7 targets are PROPOSED candidates and are reported on ADVISORY lines only");
  if (cleanupErrors.length) console.log(`NOTE cleanup errors=${cleanupErrors.length}`);
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  const setCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith("fm_session="))?.split(";")[0];
  if (loginRes.status !== 200 || !loginBody?.ok) throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`);
  if (!setCookie) throw new Error("login response carried no fm_session cookie");
  sessionCookie = setCookie;

  const tree = await json("GET", "/api/folders/tree");
  rootId = (tree.body?.data ?? []).find((f) => f.id === "folder_root")?.id
    ?? (tree.body?.data ?? []).find((f) => !f.parentId)?.id;
  if (!rootId) throw new Error("no visible root folder to build the fixture under");

  let failure = null;
  let chromeInfo = null;
  // The fixture record exists before creation starts, so a half-built fixture is
  // still cleaned up by every failure path.
  currentFixture = { created: [], roots: [], treeL1: "", subtreeIds: [], files: "", swapA: "", swapB: "", upload: "", names: {} };
  try {
    await createFixture(currentFixture);
    check("isolated timestamped fixture created and verified through the API", true,
      `folders=${currentFixture.created.length} roots=${currentFixture.roots.length} subtree=${currentFixture.subtreeIds.length} files=${FILES_FOLDER_FILES}`);
  } catch (err) {
    check("isolated timestamped fixture created and verified through the API", false, String(err?.message ?? err));
    const earlyCleanup = await cleanupFixture(currentFixture).catch((cleanupErr) => [String(cleanupErr?.message ?? cleanupErr)]);
    printSummary(chromeInfo, earlyCleanup);
    console.log("SUMMARY pass=0 total=1");
    console.error("UX_PERF_FAILED: fixture creation");
    if (earlyCleanup.length) console.error("UX_PERF_CLEANUP_FAILED: " + earlyCleanup.join(" | "));
    process.exit(1);
  }

  let chrome = null;
  let cdp = null;
  try {
    chrome = spawn("/usr/bin/google-chrome", [
      "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
      "--disable-gpu", "--window-size=1440,900",
      // Fixed 100% scale (the contract's fixed-client rule) and no background
      // throttling, so a headless page cannot be down-clocked mid-measurement.
      "--force-device-scale-factor=1",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--enable-precise-memory-info",
      "about:blank",
    ], { stdio: "ignore" });
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error(`no page target on port ${PORT}`);
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Performance.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });

    const version = await cdp.send("Browser.getVersion");
    chromeInfo = { product: version.product, jsVersion: version.jsVersion, userAgent: version.userAgent };
    check("Chrome build recorded for the fixed-client report", Boolean(chromeInfo.product), JSON.stringify(chromeInfo));

    await cdp.navigate(`${BASE}/login`);
    await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`, 15000);
    const loggedIn = await cdp.login();
    check("login through the UI", Boolean(loggedIn), String(loggedIn));
    if (!loggedIn) throw new Error("login failed; nothing can be measured");

    // A real CDP keyboard event before the timed suites: the roaming samples use
    // in-page synthetic keydowns (so the number excludes the CDP round trip),
    // and this check proves the app also reacts to the browser's own key path.
    await cdp.navigate(`${BASE}/doc?folder=${currentFixture.treeL1}`);
    await ensureTreeFolderRendered(cdp, currentFixture.treeL1);
    await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${currentFixture.treeL1}"]')!==null`, 20000);
    await cdp.evaluate(`(()=>{const li=document.querySelector('li[data-folder-id="${currentFixture.treeL1}"]');li.focus();return document.activeElement===li;})()`);
    await cdp.key("ArrowDown", "ArrowDown", 40);
    const realKey = await cdp.waitFor(`()=>{const el=document.activeElement;return el&&el.getAttribute&&el.getAttribute('data-folder-id')!==null&&el.getAttribute('data-folder-id')!=='${currentFixture.treeL1}';}`, 6000);
    check("real CDP ArrowDown also moves tree focus (synthetic-sample cross-check)", Boolean(realKey), String(realKey));

    const runSuite = async (label, fn) => {
      try { await fn(cdp); }
      catch (err) { check(`${label} suite completed`, false, String(err?.message ?? err)); }
    };
    await runSuite("PERF-01", perf01Suite);
    await runSuite("PERF-02", perf02Suite);
    await runSuite("PERF-03", perf03Suite);
    await runSuite("PERF-04", perf04Suite);
    await runSuite("PERF-06", perf06Suite);
    await runSuite("PERF-08", perf08Suite);
  } catch (err) {
    failure = err;
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
  }

  // Cleanup always runs: folders -> trash -> purge, also after a crashed suite.
  const cleanupErrors = await cleanupFixture(currentFixture).catch((err) => [String(err?.message ?? err)]);
  check("fixture cleanup removed the created folders and purged their trash", cleanupErrors.length === 0, cleanupErrors.join(" | ") || "clean");

  printSummary(chromeInfo, cleanupErrors);
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length} measurements=${measurements.length}`);
  if (failure) console.error("UX_PERF_RUN_ERROR: " + String(failure?.message ?? failure));
  if (failed.length) console.error("UX_PERF_FAILED: " + failed.map((f) => f.name).join(", "));
  if (cleanupErrors.length) console.error("UX_PERF_CLEANUP_FAILED: " + cleanupErrors.join(" | "));
  if (failure || failed.length || cleanupErrors.length) process.exit(1);
  console.log("UX_PERF_PASS");
}

// Safety net: if main() throws before its own cleanup phase (login failure, a
// dead Chrome, a network error), a fixture that already exists is still removed.
main().catch(async (err) => {
  console.error("run error: " + String(err?.message ?? err));
  let remaining = [];
  if (currentFixture && (currentFixture.created?.length ?? 0) > 0) {
    remaining = await cleanupFixture(currentFixture).catch((cleanupErr) => [String(cleanupErr?.message ?? cleanupErr)]);
    printSummary(null, remaining);
    console.error(`UX_PERF_EMERGENCY_CLEANUP: removed ${currentFixture.created.length} fixture folders`
      + (remaining.length ? ` with ${remaining.length} error(s): ${remaining.join(" | ")}` : " cleanly"));
  }
  process.exit(1);
});
