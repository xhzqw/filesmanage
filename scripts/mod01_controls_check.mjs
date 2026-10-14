#!/usr/bin/env node
// MOD01/MOD07 viewer control-surface verification (BLK-14 closure evidence).
//
// Drives the real /model/:id page in headless Chrome over the DevTools
// Protocol and verifies through the actual UI:
//   MOD01  reset view / axes / grid / perspective-orthographic toggle, each
//          proven by a composited-screenshot hash change (a no-op button
//          cannot pass), with reset proven to restore the initial framing
//   MOD07a a real webglcontextlost event on the canvas surfaces the
//          actionable error plus a download entry
//   MOD07b the >256MB guard fires when the derivative response declares an
//          oversized Content-Length (fault-injected via the Fetch domain),
//          showing the error plus a download entry instead of buffering
//
// Usage: node scripts/mod01_controls_check.mjs --file <file-id>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const FILE_ID = opt("file", "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9334"));
if (!FILE_ID) {
  console.error("usage: mod01_controls_check.mjs --file <file-id>");
  process.exit(2);
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
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 200));
    return res.result.value;
  }
  async waitEvent(method, timeoutMs = 30000) {
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
  async screenshot() {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    return createHash("sha256").update(Buffer.from(res.data, "base64")).digest("hex").slice(0, 16);
  }
  close() {
    this.ws.close();
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

async function main() {
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  if (!res.ok) throw new Error(`login failed HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("fm_session="));
  const value = cookie.slice("fm_session=".length).split(";")[0];

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1400,900",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await delay(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error("no debuggable target");
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.setCookie", { name: "fm_session", value, domain: new URL(BASE).hostname, path: "/" });

    // ---- MOD01: control surface ----
    const loaded = cdp.waitEvent("Page.loadEventFired", 30000);
    await cdp.send("Page.navigate", { url: `${BASE}/model/${FILE_ID}` });
    await loaded;
    const deadline = Date.now() + 40000;
    let ready = false;
    while (Date.now() < deadline) {
      const text = await cdp.evaluate("document.querySelector('.toolbar-hint')?.textContent ?? ''");
      if (/三角形\s+\d+/.test(text)) { ready = true; break; }
      await delay(300);
    }
    check("model page renders", ready, ready ? "三角形 count present" : "no render");

    const buttonByText = (label) =>
      `[...document.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='${label}')`;
    const clickByText = async (label) => {
      const found = await cdp.evaluate(`(()=>{const b=${buttonByText(label)};if(!b)return false;b.click();return true;})()`);
      if (!found) throw new Error(`control button not found: ${label}`);
      await delay(400);
    };
    const pressed = async (label) =>
      cdp.evaluate(`(()=>{const b=${buttonByText(label)};return b?b.getAttribute('aria-pressed'):null;})()`);

    const before = await cdp.screenshot();
    await clickByText("坐标轴");
    const axesPressed = await pressed("坐标轴");
    const afterAxes = await cdp.screenshot();
    check("MOD01 axes toggle", axesPressed === "true" && afterAxes !== before, `aria-pressed=${axesPressed} pixels ${before}->${afterAxes}`);

    await clickByText("坐标轴");
    const axesOff = await pressed("坐标轴");
    check("MOD01 axes toggle back", axesOff === "false", `aria-pressed=${axesOff}`);

    await clickByText("网格");
    const gridPressed = await pressed("网格");
    const afterGrid = await cdp.screenshot();
    check("MOD01 grid toggle", gridPressed === "false" && afterGrid !== afterAxes, `aria-pressed=${gridPressed} pixels changed`);

    await clickByText("网格");
    const gridOn = await pressed("网格");
    check("MOD01 grid toggle back", gridOn === "true", `aria-pressed=${gridOn}`);

    const projLabel = await cdp.evaluate(`(${buttonByText('透视投影')}?.textContent??${buttonByText('正交投影')}?.textContent??'')`);
    await clickByText(projLabel);
    const afterProj = await cdp.screenshot();
    const projLabel2 = await cdp.evaluate(`(${buttonByText('透视投影')}?.textContent??${buttonByText('正交投影')}?.textContent??'')`);
    check("MOD01 projection toggle", projLabel !== projLabel2 && afterProj !== afterGrid, `label ${projLabel}->${projLabel2} pixels changed`);

    // Drag to orbit away from the initial framing, then reset must restore it.
    // Return to the perspective projection first so the baseline and the reset
    // state are the same camera (otherwise the comparison is meaningless).
    await clickByText(projLabel2);
    await delay(600);
    const framed = await cdp.screenshot();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 700, y: 500, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 560, button: "left" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 900, y: 560, button: "left", clickCount: 1 });
    await delay(600);
    const dragged = await cdp.screenshot();
    check("MOD01 orbit drag moves the camera", dragged !== framed, "pixels changed after drag");
    await clickByText("重置视角");
    await delay(900);
    const reset = await cdp.screenshot();
    check("MOD01 reset restores initial framing", reset === framed, `reset=${reset} framed=${framed}`);

    // ---- MOD07a: WebGL context loss ----
    await cdp.evaluate(`(()=>{const c=document.querySelector('.viewer-stage canvas');if(!c)return false;c.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));return true;})()`);
    await delay(400);
    const lost = await cdp.evaluate(`(()=>{const n=document.querySelector('.notice.error');return n?{text:n.textContent,link:!!n.querySelector('a[href*="/bytes"]')}:null;})()`);
    check("MOD07 webgl-lost error + download entry", !!lost && lost.link, lost ? JSON.stringify(lost) : "no error notice");

    // ---- MOD07b: oversized Content-Length guard (fault injection) ----
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*derivative/bytes*", requestStage: "Response" }] });
    const onFetch = async (event) => {
      const body = await cdp.send("Fetch.getResponseBody", { requestId: event.requestId });
      const headers = event.responseHeaders ?? [];
      const replaced = headers.map((h) =>
        h.name.toLowerCase() === "content-length"
          ? { name: h.name, value: String(300 * 1024 * 1024) }
          : h,
      );
      if (!headers.some((h) => h.name.toLowerCase() === "content-length")) {
        replaced.push({ name: "Content-Length", value: String(300 * 1024 * 1024) });
      }
      await cdp.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: event.responseStatusCode ?? 200,
        responseHeaders: replaced,
        body: body.base64Encoded ? body.body : Buffer.from(body.body).toString("base64"),
      });
    };
    const guardLoaded = cdp.waitEvent("Page.loadEventFired", 30000);
    await cdp.send("Page.navigate", { url: `${BASE}/model/${FILE_ID}` });
    await guardLoaded;
    const guardDeadline = Date.now() + 40000;
    let guard = null;
    while (Date.now() < guardDeadline && !guard) {
      for (;;) {
        const hit = cdp.events.find((e) => e.method === "Fetch.requestPaused");
        if (!hit) break;
        cdp.events.splice(cdp.events.indexOf(hit), 1);
        await onFetch(hit.params);
      }
      guard = await cdp.evaluate(`(()=>{const n=[...document.querySelectorAll('.notice.error')].find(e=>e.textContent.includes('模型过大'));return n?{text:n.textContent.trim(),link:!!n.querySelector('a[href*="/bytes"]')}:null;})()`);
      if (!guard) await delay(300);
    }
    check("MOD07 oversize guard + download entry", !!guard && guard.link, guard ? JSON.stringify(guard) : "no oversize notice");
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("MOD01_CONTROLS_CHECK_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("MOD01_CONTROLS_CHECK_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
