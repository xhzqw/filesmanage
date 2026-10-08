#!/usr/bin/env node
// PE15 / MOD08: WebGL viewer heap growth across repeated load/teardown cycles.
//
// Drives the real model page in headless Chrome over the DevTools Protocol
// (Node 22 built-in WebSocket, no dependencies), forces a GC between samples
// and reports the JS heap after each mount and after each teardown. A viewer
// that leaks geometry, textures or WebGL contexts shows a rising teardown
// baseline; a disposing viewer stays flat.
//
// Usage:
//   node scripts/pe15_heap_growth.mjs --file <file-id> [--cycles 10]
//     [--base http://127.0.0.1:18091] [--password-file .secrets/admin.password]
//     [--port 9333] [--report]
//
// --report prints measurements without asserting; the default mode asserts:
//   * every cycle renders the mesh (triangle count stable across cycles)
//   * the teardown baseline does not trend upward beyond the growth budget,
//     in particular not after warmup (late-window slope)
//   * with --control-json, the late-window slope stays within a small margin
//     of a doc-only control run, which absorbs JIT/IC and SPA bootstrap cost
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const FILE_ID = opt("file", "");
const CYCLES = Number(opt("cycles", "10"));
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9333"));
const REPORT = flag("report");
const CONTROL = flag("control");
// Teardown heap may legitimately wobble; a real leak trends upward. The budget
// is per-cycle slope plus absolute headroom, both far above jitter.
const SLOPE_BUDGET_MB = Number(opt("slope-budget-mb", "1.5"));
const ABSOLUTE_BUDGET_MB = Number(opt("absolute-budget-mb", "40"));
// Late-window (post-warmup) slope budget: a leak keeps climbing after warmup,
// a healthy viewer returns to a stable floor.
const LATE_SLOPE_BUDGET_MB = Number(opt("late-slope-budget-mb", "0.5"));
// The model page may not trend up faster than the control page's late slope by
// more than this absolute margin (the control absorbs SPA/navigation cost).
const CONTROL_MARGIN_BUDGET_MB = Number(opt("control-margin-budget-mb", "0.5"));

if (!FILE_ID && !CONTROL) {
  console.error("usage: pe15_heap_growth.mjs --file <file-id> [--cycles N] [--control]");
  process.exit(2);
}

const CHROME = "/usr/bin/google-chrome";

async function login() {
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("fm_session="));
  if (!cookie) throw new Error("login response carried no fm_session cookie");
  return cookie.split(";")[0];
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
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
  async evaluate(expression, awaitPromise = false) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails));
    return res.result.value;
  }
  async waitEvent(method, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((e) => e.method === method);
      if (hit) {
        this.events.splice(this.events.indexOf(hit), 1);
        return hit;
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${method}`);
      await delay(50);
    }
  }
  close() {
    this.ws.close();
  }
}

async function heapMb(cdp) {
  const raw = await cdp.evaluate("performance.memory ? performance.memory.usedJSHeapSize : -1");
  return raw < 0 ? null : raw / (1024 * 1024);
}

async function waitRendered(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await cdp.evaluate(
      "document.querySelector('.toolbar-hint') ? document.querySelector('.toolbar-hint').textContent : ''",
    );
    const match = /三角形\s+(\d+)/.exec(text || "");
    if (match && Number(match[1]) > 0) return Number(match[1]);
    if (Date.now() > deadline) throw new Error("mesh never rendered (no 三角形 count in toolbar)");
    await delay(250);
  }
}

async function navigate(cdp, url) {
  const loaded = cdp.waitEvent("Page.loadEventFired", 30000);
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function main() {
  const cookie = await login();
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--js-flags=--expose-gc",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  let cdp;
  const cycles = [];
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await delay(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch {
        /* devtools not up yet */
      }
    }
    if (!target) throw new Error("no debuggable page target");
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const host = new URL(BASE).hostname;
    await cdp.send("Network.setCookie", {
      name: "fm_session",
      value: cookie.slice("fm_session=".length),
      domain: host,
      path: "/",
    });

    for (let i = 1; i <= CYCLES; i++) {
      let triangles = null;
      if (CONTROL) {
        await navigate(cdp, `${BASE}/doc`);
        await delay(500);
      } else {
        await navigate(cdp, `${BASE}/model/${FILE_ID}`);
        triangles = await waitRendered(cdp);
        await delay(500);
      }
      await cdp.evaluate("gc && gc()");
      const loaded = await heapMb(cdp);
      await navigate(cdp, `${BASE}/doc`);
      await delay(500);
      await cdp.evaluate("gc && gc()");
      const torn = await heapMb(cdp);
      cycles.push({ cycle: i, triangles, loadedMb: loaded, teardownMb: torn });
      console.log(
        `cycle ${String(i).padStart(2)}  ${triangles === null ? "control" : "triangles=" + triangles}  loaded=${loaded?.toFixed(1)}MB  teardown=${torn?.toFixed(1)}MB`,
      );
    }
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  const torn = cycles.map((c) => c.teardownMb);
  const xs = cycles.map((c) => c.cycle);
  const n = xs.length;
  const slopeOf = (from, to) => {
    const px = xs.slice(from, to);
    const py = torn.slice(from, to);
    const m = px.length;
    const mx = px.reduce((a, b) => a + b, 0) / m;
    const my = py.reduce((a, b) => a + b, 0) / m;
    const denom = px.reduce((acc, x) => acc + (x - mx) ** 2, 0);
    return denom === 0 ? 0 : px.reduce((acc, x, i) => acc + (x - mx) * (py[i] - my), 0) / denom;
  };
  const slope = slopeOf(0, n);
  // Warmup (JIT, arena growth, first-time allocations) inflates early cycles;
  // a real leak keeps a constant positive slope in the late window, while a
  // healthy viewer returns to a stable floor.
  const lateSlope = slopeOf(Math.floor(n / 2), n);
  const first = torn[0];
  const last = torn[n - 1];
  const growth = last - first;
  const triangleSets = new Set(cycles.map((c) => c.triangles));

  console.log(`teardown slope: ${slope.toFixed(3)} MB/cycle over ${n} cycles (budget ${SLOPE_BUDGET_MB})`);
  console.log(`teardown late-window slope: ${lateSlope.toFixed(3)} MB/cycle over the last ${n - Math.floor(n / 2)} cycles (budget ${LATE_SLOPE_BUDGET_MB})`);
  console.log(`teardown growth: first=${first.toFixed(1)}MB last=${last.toFixed(1)}MB delta=${growth.toFixed(1)}MB (budget ${ABSOLUTE_BUDGET_MB})`);
  if (!CONTROL) console.log(`triangle counts stable: ${triangleSets.size === 1} (${[...triangleSets].join(",")})`);

  const summary = {
    control: CONTROL,
    fileId: CONTROL ? null : FILE_ID,
    cycles: n,
    teardownSlopeMbPerCycle: Number(slope.toFixed(4)),
    teardownLateSlopeMbPerCycle: Number(lateSlope.toFixed(4)),
    teardownGrowthMb: Number(growth.toFixed(2)),
    firstTeardownMb: Number(first.toFixed(2)),
    lastTeardownMb: Number(last.toFixed(2)),
    triangles: CONTROL ? null : [...triangleSets],
    samples: cycles,
  };
  const outPath = opt("out", "");
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`summary written: ${outPath}`);
  }

  if (REPORT) {
    console.log("PE15_HEAP_REPORT_DONE (report mode, no assertion)");
    return;
  }

  const failures = [];
  if (!CONTROL && triangleSets.size !== 1) failures.push("mesh did not render identically every cycle");
  if (slope > SLOPE_BUDGET_MB) failures.push(`teardown heap trends up at ${slope.toFixed(2)} MB/cycle`);
  if (lateSlope > LATE_SLOPE_BUDGET_MB) failures.push(`late-window teardown slope ${lateSlope.toFixed(2)} MB/cycle exceeds ${LATE_SLOPE_BUDGET_MB}`);
  if (growth > ABSOLUTE_BUDGET_MB) failures.push(`teardown heap grew ${growth.toFixed(1)}MB over ${n} cycles`);
  const controlPath = opt("control-json", "");
  if (controlPath && !CONTROL) {
    const control = JSON.parse(readFileSync(controlPath, "utf8"));
    const margin = lateSlope - control.teardownLateSlopeMbPerCycle;
    console.log(`vs control late slope: model=${lateSlope.toFixed(3)} control=${control.teardownLateSlopeMbPerCycle} margin=${margin.toFixed(3)}MB/cycle (budget ${CONTROL_MARGIN_BUDGET_MB})`);
    if (margin > CONTROL_MARGIN_BUDGET_MB) {
      failures.push(`model-page late-window slope exceeds the doc-only control by ${margin.toFixed(2)} MB/cycle`);
    }
  }

  if (failures.length) {
    console.error("PE15_HEAP_GROWTH_FAILED: " + failures.join("; "));
    process.exit(1);
  }
  console.log(`PE15_HEAP_GROWTH_PASS cycles=${n} slope=${slope.toFixed(3)} late=${lateSlope.toFixed(3)} growth=${growth.toFixed(1)}MB`);
}

main().catch((err) => {
  console.error("PE15 run error: " + err.message);
  process.exit(1);
});
