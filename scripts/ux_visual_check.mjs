#!/usr/bin/env node
// Visual & accessibility gate (UX-ACCEPTANCE-v1 §6 VIS-01..VIS-08/VIS-11, §8 G5;
// DESIGN-SYSTEM-v1 §2.2/§5): fixed three-viewport screenshots plus a11y
// metadata over the real UI.
//
// For /doc, /trash, /org, /approvals and /preview/:id (a real file id resolved
// through the API) at 1366x768, 1440x900 and 1920x1080 it asserts per viewport:
//   - no horizontal document overflow (scrollWidth <= clientWidth + 1);
//   - the page's primary action sits inside the viewport (upload control on
//     /doc, restore button on /trash, workgroup-creation button on /org,
//     approve button on /approvals, download link on /preview);
//   - the table and the breadcrumb are reachable (non-zero size).
// It captures one PNG per route+viewport into docs/evidence/ux/ and reports
// the paths, then asserts the a11y metadata on /doc (role=grid with
// aria-label, aria-selected rows, role=tree with treeitems, one shell nav
// with the full label set). The a11y assertions run on the same /doc route
// pinned to this gate's fixture folder so the grid is guaranteed to carry
// real rows.
//
// The visual-governance slice (VIS-01/02/03/06/07/08/11) then runs on top of
// that session:
//   - VIS-03 contrast: a WCAG 2.x engine reads getComputedStyle colors in the
//     real browser for a fixed set of (selector, background) pairs on every
//     main route — body-size text >= 4.5:1, large text and non-text UI
//     boundaries (focus rings, selected-row border, input/select borders)
//     >= 3:1. Backgrounds are resolved by walking the ancestor chain and
//     compositing rgba layers; the computed ratios are printed as
//     CONTRAST evidence lines and saved per route to
//     docs/evidence/ux/contrast-<route>.json.
//   - VIS-02 row states: the hover/selected/focused CSS rules must exist and
//     the default, hover and selected row backgrounds must be distinguishable.
//   - VIS-08 long filenames: a fixture file with a 60+ character mixed Chinese
//     name must render with ellipsis while the full name stays reachable
//     (title / aria-label).
//   - VIS-07 prefers-reduced-motion: CDP Emulation.setEmulated media plus a
//     reload; elements that animate by default must drop to 0s, or a matching
//     reduced-motion rule must exist and apply.
//   - VIS-01/06 static governance: web/src/shared/ui and web/src/features CSS
//     (everything newer than the theme.css token layer) must use var(--...)
//     tokens only and carry no emoji; the documented menu.css shadow exception
//     and var() fallbacks are allowed.
//   - VIS-11 a11y metadata: every image/icon aria-hidden or labelled, the
//     dialog exposes its accessible name, column headers expose scope/role.
//
// This gate is new content (no ad-hoc source) and is independent of
// browser_journey_check.mjs / browser_business_check.mjs. One Chrome session
// is reused for every navigation.
//
// Usage: node scripts/ux_visual_check.mjs [--base http://127.0.0.1:18091]
//        [--password-file .secrets/admin.password] [--port 9362]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9362"));
const EVIDENCE_DIR = "docs/evidence/ux";

assertIsolatedFixtures({base:BASE,args,explicitBase:args.includes("--base")});

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const NAV_LABELS = ["文档管理", "全局搜索", "共享/关注", "统计", "审批", "回收站", "组织与权限"];

// ---------------------------------------------------------------------------
// VIS-01/06 static governance (DESIGN-SYSTEM-v1 §2/§5, UX-ACCEPTANCE §1.2 S):
// component CSS newer than the token layer must consume semantic tokens only.
// theme.css itself is the token definition plus the documented legacy
// migration backlog, so the scan covers shared/ui and features only. A hex
// literal inside a var(--token, #hex) fallback is governed by the token and is
// allowed; the single shadow exception is documented in the file's own header.
// ---------------------------------------------------------------------------
const GOVERNANCE_ROOTS = ["web/src/shared/ui", "web/src/features"];
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
const EMOJI_LITERAL = /[\p{Emoji_Presentation}]|[\p{Extended_Pictographic}]\uFE0F/gu;
const DOCUMENTED_COLOR_EXCEPTIONS = [
  { file: "web/src/shared/ui/menu.css", value: "#1740981f", reason: "menu.css header: the popup shadow has no token yet and follows the existing alpha-hex pattern" },
];

function cssFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...cssFilesUnder(path));
    else if (entry.name.endsWith(".css")) out.push(path);
  }
  return out;
}

function scanComponentGovernance() {
  const files = [];
  const violations = [];
  const exceptions = [];
  for (const root of GOVERNANCE_ROOTS) {
    if (!existsSync(root)) {
      violations.push({ file: root, line: 0, kind: "scan", value: "", text: "governance root missing" });
      continue;
    }
    files.push(...cssFilesUnder(root).sort());
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const at = i + 1;
      for (const m of line.matchAll(HEX_LITERAL)) {
        const before = line.slice(0, m.index);
        const varOpen = before.lastIndexOf("var(");
        if (varOpen >= 0 && !before.slice(varOpen).includes(")")) continue; // token fallback
        const documented = DOCUMENTED_COLOR_EXCEPTIONS.find((x) => x.file === file && line.includes(x.value));
        if (documented) {
          exceptions.push({ file, line: at, value: m[0], reason: documented.reason });
          continue;
        }
        violations.push({ file, line: at, kind: "hex", value: m[0], text: line.trim().slice(0, 140) });
      }
      const emoji = line.match(EMOJI_LITERAL);
      if (emoji) violations.push({ file, line: at, kind: "emoji", value: emoji.join(""), text: line.trim().slice(0, 140) });
    }
  }
  return { roots: GOVERNANCE_ROOTS, files, violations, exceptions };
}

// ---------------------------------------------------------------------------
// VIS-03 contrast pairs. Text pairs run on every main route; a pair whose
// selector is absent is recorded as skipped (never a silent pass). Non-text
// boundary pairs (>=3:1) run on /doc where the interactive states live.
// ---------------------------------------------------------------------------
const ROUTE_TEXT_PAIRS = [
  { id: "nav-link", sel: "header.header nav a" },
  { id: "breadcrumb-text", sel: ".breadcrumb" },
  { id: "breadcrumb-link", sel: ".breadcrumb a" },
  { id: "toolbar-hint", sel: ".toolbar-hint" },
  { id: "table-header", sel: "table thead th" },
  { id: "row-name-cell", sel: "tbody tr td:first-child" },
  { id: "row-cell", sel: "tbody tr td:nth-child(2)" },
  { id: "file-name", sel: "tbody tr[data-id] .file-name" },
  { id: "tree-row-label", sel: ".tree-row a, .tree-row .org-node-label" },
  { id: "hint", sel: ".hint" },
  { id: "notice", sel: "p.notice:not(.error)" },
  { id: "error-notice", sel: "p.notice.error" },
  { id: "empty-state", sel: ".empty" },
  { id: "hash", sel: ".hash" },
  { id: "primary-action", sel: "a.primary, button.primary" },
  { id: "row-actions-link", sel: ".row-actions a" },
  { id: "row-actions-button", sel: ".row-actions button" },
  { id: "danger-label", sel: ".row-actions .danger, button.danger" },
  { id: "secondary-action", sel: ".secondary-action" },
  { id: "preview-text", sel: ".preview-text" },
];

// VIS-08 fixture: a 60+ character mixed Chinese name (165 bytes, under the
// server's 200-byte upload limit) so the row must ellipsis yet stay reachable.
const LONG_FILE_PREFIX = "超长中文文件名混排-";
const LONG_FILE_NAME = `${LONG_FILE_PREFIX}#%-${stamp}-` + "文档资料".repeat(10);

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
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 200));
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
  close() { this.ws.close(); }
}

// A selector expression that returns the element carrying the page's primary
// action (or null); each one mirrors the surface the other gates drive. On
// /org the workgroup-creation button is used: the user-creation form lives
// below the (unbounded, internally scrolling) user list, so it is not
// guaranteed to be inside the initial viewport on a long-lived dev instance.
const PRIMARY_FINDERS = {
  doc: `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.querySelector('input[type=file]'));
    return document.querySelector('.upload-button')||label||document.querySelector('input[type=file]')||null;})()`,
  trash: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='恢复')||null)()`,
  org: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='创建工作组')||null)()`,
  approvals: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过')||null)()`,
  preview: `(()=>document.querySelector('.file-workbench-actions button.primary')||null)()`,
};

const PRIMARY_LABELS = {
  doc: "上传文件",
  trash: "恢复",
  org: "创建工作组",
  approvals: "通过",
  preview: "下载",
};

// One real-key press (rawKeyDown + keyUp) through the CDP Input domain.
async function keyPress(cdp, key, code, vk) {
  const params = { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send("Input.dispatchKeyEvent", params);
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

// The browser-side measurement engine (VIS-02/03/07/08/11). It is injected as
// a function and called with one command object per measurement:
//   {op:"texts"|"boundaries"|"boundary"|"focusRing"|"animated"|"rules"|"media"|
//    "a11y"|"dialog"|"rowState"|"longName", ...}
// Contrast math follows WCAG 2.x: relative luminance with the sRGB
// linearization, ratio (L1+0.05)/(L2+0.05); large text is >=24px or >=18.66px
// bold. Backgrounds are resolved by walking the ancestor chain and
// compositing every semi-transparent layer over the first opaque one (the
// canvas default is white), so "the panel behind the text" is measured, not
// assumed. Nothing here may throw: every measurement returns a record.
const VIS_ENGINE = `(() => {
  const parseColor = (value) => {
    if (!value) return null;
    const v = String(value).trim();
    if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const m = v.match(/^rgba?\\(([^)]+)\\)$/i);
    if (m) {
      const parts = m[1].split(/[,\\s]+/).filter((p) => p !== "").map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
    }
    const h = v.match(/^#([0-9a-f]{3,8})$/i);
    if (h) {
      const d = h[1];
      const at = (i) => parseInt(d.length === 3 || d.length === 4 ? d.slice(i, i + 1).repeat(2) : d.slice(i * 2, i * 2 + 2), 16);
      return { r: at(0), g: at(1), b: at(2), a: d.length === 4 || d.length === 8 ? at(3) / 255 : 1 };
    }
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const round2 = (n) => Math.round(n * 100) / 100;
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("class") ? "." + String(el.getAttribute("class")).trim().split(/\\s+/).join(".") : "");
  const backgroundOf = (el) => {
    const layers = [];
    const chain = [];
    let gradient = false;
    let node = el;
    while (node && node.nodeType === 1) {
      const s = getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== "none") gradient = true;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        chain.push(describe(node) + (c.a < 1 ? "@" + c.a : ""));
        if (c.a >= 1) break;
      }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    return { color: base, chain, gradient };
  };
  const directText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
  const textCarrier = (el) => {
    if (directText(el)) return el;
    let found = null;
    const walk = (node) => {
      for (const child of node.children || []) {
        if (found) return;
        if (directText(child)) { found = child; return; }
        walk(child);
      }
    };
    walk(el);
    return found || el;
  };
  const measureText = (pair) => {
    try {
      const el = document.querySelector(pair.sel);
      if (!el) return { id: pair.id, kind: "text", skipped: true, reason: "selector not present: " + pair.sel };
      const target = textCarrier(el);
      const s = getComputedStyle(target);
      if (s.display === "none" || s.visibility === "hidden" || target.getClientRects().length === 0)
        return { id: pair.id, kind: "text", skipped: true, reason: "not visible: " + pair.sel };
      const fgRaw = parseColor(s.color);
      if (!fgRaw) return { id: pair.id, kind: "text", skipped: true, reason: "unparsable color: " + s.color };
      const bg = backgroundOf(target);
      const fg = over(fgRaw, bg.color);
      const size = parseFloat(s.fontSize) || 16;
      const weight = s.fontWeight === "bold" ? 700 : Number(s.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const r = ratio(fg, bg.color);
      return {
        id: pair.id, kind: "text", selector: pair.sel, measuredAs: describe(target),
        fg: hex(fg), fgRaw: s.color, bg: hex(bg.color), bgChain: bg.chain, gradientBackground: bg.gradient,
        fontSize: size, fontWeight: weight, largeText: large,
        ratio: round2(r), required, ok: r >= required - 1e-9, note: "",
      };
    } catch (err) {
      return { id: pair.id, kind: "text", skipped: true, reason: "engine error: " + String(err && err.message) };
    }
  };
  const measureBoundary = (pair) => {
    try {
      const el = document.querySelector(pair.sel);
      if (!el) return { id: pair.id, kind: pair.kind, skipped: true, reason: "selector not present: " + pair.sel };
      const s = getComputedStyle(el);
      const own = backgroundOf(el).color;
      const parent = el.parentElement ? backgroundOf(el.parentElement).color : own;
      const bounds = [];
      ["Top", "Right", "Bottom", "Left"].forEach((side) => {
        const w = parseFloat(s["border" + side + "Width"]) || 0;
        const style = s["border" + side + "Style"];
        const c = parseColor(s["border" + side + "Color"]);
        if (w > 0 && style !== "none" && style !== "hidden" && c && c.a > 0)
          bounds.push({ part: "border-" + side.toLowerCase(), width: w, rgba: over(c, own), color: hex(over(c, own)) });
      });
      if (s.outlineStyle && s.outlineStyle !== "none" && (parseFloat(s.outlineWidth) || 0) > 0) {
        const c = parseColor(s.outlineColor);
        if (c && c.a > 0) {
          const composited = over(c, parent);
          bounds.push({ part: "outline", width: parseFloat(s.outlineWidth), rgba: composited, color: hex(composited) });
        }
      }
      if (s.boxShadow && s.boxShadow !== "none" && s.boxShadow.indexOf("inset") >= 0) {
        const m = s.boxShadow.match(/rgba?\\([^)]+\\)/);
        const c = m ? parseColor(m[0]) : null;
        if (c && c.a > 0) bounds.push({ part: "inset box-shadow", width: null, rgba: over(c, own), color: hex(over(c, own)) });
      }
      const required = 3;
      const measured = bounds.map((b) => Object.assign({}, b, {
        ratioElement: round2(ratio(b.rgba, own)),
        ratioParent: round2(ratio(b.rgba, parent)),
        ok: ratio(b.rgba, own) >= required - 1e-9 && ratio(b.rgba, parent) >= required - 1e-9,
      }));
      return {
        id: pair.id, kind: pair.kind, selector: pair.sel, measuredAs: describe(el),
        required, boundaries: measured,
        active: document.activeElement === el, focusVisible: el.matches(":focus-visible"),
        ratio: measured.length ? round2(Math.min.apply(null, measured.map((b) => Math.min(b.ratioElement, b.ratioParent)))) : null,
        ok: measured.length > 0 && measured.every((b) => b.ok),
        note: measured.length ? "" : "no border/outline/inset ring present on " + describe(el),
      };
    } catch (err) {
      return { id: pair.id, kind: pair.kind, skipped: true, reason: "engine error: " + String(err && err.message) };
    }
  };
  const seconds = (value) => String(value || "0s").split(",").map((v) => {
    const t = v.trim();
    const n = parseFloat(t);
    if (Number.isNaN(n)) return 0;
    return t.slice(-2) === "ms" ? n / 1000 : n;
  }).reduce((a, b) => Math.max(a, b), 0);
  // The standard reduced-motion idiom keeps durations at .01ms (above 0s so a
  // pending transitionend still fires once), so anything at or below 10ms
  // counts as disabled rather than as surviving motion.
  const MOTION_EPSILON = 0.01;
  const animated = () => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      const td = seconds(s.transitionDuration);
      const ad = seconds(s.animationDuration);
      if (td > MOTION_EPSILON || ad > MOTION_EPSILON) out.push({ element: describe(el), transitionDuration: s.transitionDuration, animationDuration: s.animationDuration });
    }
    return out;
  };
  const MEDIA_RULE = (window.CSSRule && CSSRule.MEDIA_RULE) || 4;
  const eachRule = (fn) => {
    const walk = (rules) => {
      for (const rule of rules || []) {
        fn(rule);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch (err) { /* cross-origin sheet */ }
    }
  };
  const rulesMatching = (pattern) => {
    const hits = [];
    const re = new RegExp(pattern);
    eachRule((rule) => {
      if (!rule.selectorText) return;
      for (const sel of rule.selectorText.split(",")) {
        if (re.test(sel.trim())) { hits.push({ selector: rule.selectorText.trim().slice(0, 160), css: rule.cssText.slice(0, 200) }); return; }
      }
    });
    return hits;
  };
  const mediaRules = () => {
    const out = [];
    eachRule((rule) => {
      if (rule.type !== MEDIA_RULE || !rule.conditionText) return;
      const inner = [];
      for (const r of rule.cssRules || []) inner.push(r.cssText);
      out.push({
        condition: rule.conditionText,
        matches: typeof rule.matches === "boolean" ? rule.matches : null,
        declarations: inner.join(" | ").slice(0, 400),
        hasDeclarations: inner.length > 0 && /animation|transition/.test(inner.join(" ")),
      });
    });
    return out;
  };
  const namedBy = (el) => {
    const id = el.getAttribute("aria-labelledby");
    const viaId = id ? document.getElementById(id) : null;
    return ((el.getAttribute("aria-label") || (viaId ? viaId.textContent : "") || (el.tagName === "IMG" ? el.alt : "") || "")).trim();
  };
  const a11yAudit = () => {
    const images = [];
    for (const el of document.querySelectorAll("img, svg")) {
      const hidden = el.getAttribute("aria-hidden") === "true" || Boolean(el.closest("[aria-hidden='true']"));
      const title = el.querySelector("title");
      const own = namedBy(el) || (title ? (title.textContent || "").trim() : "");
      let ancestor = false;
      if (!hidden && !own) {
        let p = el.parentElement;
        for (let d = 0; p && d < 4; d += 1) {
          const role = p.getAttribute("role");
          if (role && role !== "presentation" && role !== "none" && namedBy(p)) { ancestor = true; break; }
          p = p.parentElement;
        }
      }
      images.push({ element: describe(el), hidden, labelled: Boolean(own), ancestorLabelled: ancestor, ok: Boolean(hidden || own || ancestor) });
    }
    const headers = [...document.querySelectorAll("table thead th")].map((th) => ({
      text: (th.textContent || "").trim().slice(0, 10), scope: th.getAttribute("scope"), role: th.getAttribute("role"),
      ok: Boolean(th.getAttribute("scope") || th.getAttribute("role")),
    }));
    return { images, headers };
  };
  const dialogName = () => {
    const d = document.querySelector("dialog[open]");
    if (!d) return { found: false, ok: false };
    const name = namedBy(d);
    return { found: true, name, ok: name.length > 0 };
  };
  const rowState = () => {
    const rows = [...document.querySelectorAll("tbody tr[data-id]")];
    const pick = (fn) => rows.find(fn) || null;
    const hovered = pick((r) => r.matches(":hover"));
    const selected = pick((r) => r.classList.contains("selected"));
    const plain = pick((r) => !r.classList.contains("selected") && !r.matches(":hover"));
    const focused = pick((r) => r.classList.contains("focused"));
    const bg = (el) => (el ? hex(backgroundOf(el).color) : null);
    const nameOf = (el) => (el ? String(el.querySelector(".file-name")?.textContent ?? "").slice(0, 40) : "");
    return {
      rows: rows.length,
      defaultBg: bg(plain), hoverBg: bg(hovered), selectedBg: bg(selected),
      focusedRow: focused ? { element: describe(focused), name: nameOf(focused), tabIndex: focused.tabIndex } : null,
    };
  };
  const longNameRow = (name) => {
    const span = [...document.querySelectorAll("tbody tr[data-id] .file-name")].find((s) => s.textContent === name);
    if (!span) return { found: false, ok: false, reason: "row for the long fixture name not rendered" };
    const s = getComputedStyle(span);
    const title = (span.getAttribute("title") || "").trim();
    const aria = (span.getAttribute("aria-label") || "").trim();
    return {
      found: true,
      textOverflow: s.textOverflow, whiteSpace: s.whiteSpace, overflow: s.overflow,
      truncated: span.scrollWidth > span.clientWidth, clientWidth: span.clientWidth, scrollWidth: span.scrollWidth,
      title, ariaLabel: aria,
      fullNameReachable: title.includes(name) || aria.includes(name),
      ok: s.textOverflow === "ellipsis" && s.whiteSpace === "nowrap"
        && span.scrollWidth > span.clientWidth && (title.includes(name) || aria.includes(name)),
    };
  };
  return (cmd) => {
    if (cmd.op === "text") return measureText(cmd.pair);
    if (cmd.op === "texts") return cmd.pairs.map(measureText);
    if (cmd.op === "boundary") return measureBoundary(cmd.pair);
    if (cmd.op === "focusRing") {
      const el = document.querySelector(cmd.sel);
      if (!el) return { id: cmd.id, kind: "outline", skipped: true, reason: "selector not present: " + cmd.sel };
      el.focus();
      const out = measureBoundary({ id: cmd.id, kind: "outline", sel: cmd.sel });
      out.focused = document.activeElement === el;
      out.focusVisible = el.matches(":focus-visible");
      return out;
    }
    if (cmd.op === "animated") return animated();
    if (cmd.op === "rules") return rulesMatching(cmd.pattern);
    if (cmd.op === "media") return mediaRules();
    if (cmd.op === "a11y") return a11yAudit();
    if (cmd.op === "dialog") return dialogName();
    if (cmd.op === "rowState") return rowState();
    if (cmd.op === "longName") return longNameRow(cmd.name);
    throw new Error("unknown engine op " + cmd.op);
  };
})()`;

const vis = (cdp, cmd) => cdp.evaluate(`(${VIS_ENGINE})(${JSON.stringify(cmd)})`);

// One measured pair: the CONTRAST evidence line the contract asks for plus a
// gate check. Skipped pairs (selector absent) are recorded, never passed.
function reportPair(route, pair) {
  if (pair.skipped) {
    console.log(`CONTRAST ${route} ${pair.id} SKIP :: ${pair.reason}`);
    return;
  }
  console.log(`CONTRAST ${route} ${pair.id} ratio=${pair.ratio} required=${pair.required} ${pair.ok ? "PASS" : "FAIL"}`);
  const detail = pair.kind === "text"
    ? JSON.stringify({ fg: pair.fg, bg: pair.bg, bgChain: pair.bgChain, fontSize: pair.fontSize, fontWeight: pair.fontWeight, large: pair.largeText, measuredAs: pair.measuredAs, gradient: pair.gradientBackground })
    : JSON.stringify({ ratio: pair.ratio, boundaries: pair.boundaries, measuredAs: pair.measuredAs, active: pair.active, focusVisible: pair.focusVisible, note: pair.note });
  check(`VIS-03 ${route}: ${pair.id} ${pair.kind === "text" ? "text" : "boundary"} contrast >= ${pair.required}:1`, pair.ok, detail);
}

function writeContrastEvidence(route, url, pairs) {
  const file = `${EVIDENCE_DIR}/contrast-${route}.json`;
  const present = pairs.filter((p) => !p.skipped);
  const payload = {
    id: "VIS-03",
    route,
    url,
    viewport: "1440x900",
    stamp,
    measuredAt: new Date().toISOString(),
    standard: "WCAG 2.x AA (DESIGN-SYSTEM-v1 §2.2/§5): body-size text >= 4.5:1; large text (>=24px or >=18.66px bold) and non-text UI boundaries >= 3:1",
    backgroundResolution: "effective background = ancestor chain with every semi-transparent layer composited over the first opaque layer (canvas default white)",
    summary: {
      measured: present.length,
      pass: present.filter((p) => p.ok).length,
      fail: present.filter((p) => !p.ok).length,
      skipped: pairs.length - present.length,
    },
    pairs,
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function main() {
  // ---- fixtures (API session) ----
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith("fm_session=")).split(";")[0];
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tree = await json("GET", "/api/folders/tree");
  const rootId = (tree.body?.data ?? []).find((f) => f.id === "folder_root")?.id
    ?? (tree.body?.data ?? []).find((f) => !f.parentId)?.id;
  const me = (await json("GET", "/api/me")).body?.data;

  const uploadTo = async (folderId, name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", "ux-visual-" + name + "-" + stamp);
    const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
    return (await res.json()).data;
  };

  // /doc needs real rows (a11y), /preview needs a real file id, /trash needs a
  // row with a restore action: three files in one folder, one of them deleted.
  const visFolderId = (await json("POST", "/api/folders", { parentId: rootId, name: "UX-VIS-" + stamp })).body?.data?.id;
  await uploadTo(visFolderId, "vis-keep.txt", `visual keep ${stamp}\n`);
  const previewFile = await uploadTo(visFolderId, "vis-preview.txt", `visual preview ${stamp}\n`);
  const trashFile = await uploadTo(visFolderId, "vis-trash.txt", `visual trash ${stamp}\n`);
  await json("DELETE", `/api/files/${trashFile.fileId}`);
  // VIS-08: a 60+ character mixed Chinese name that must ellipsis yet stay
  // reachable through title/aria-label.
  const longNameFile = await uploadTo(visFolderId, LONG_FILE_NAME, `visual long name ${stamp}\n`);
  check("VIS-08 fixture: long Chinese filename uploaded intact",
    longNameFile?.name === LONG_FILE_NAME,
    `expected ${LONG_FILE_NAME.length} chars, stored ${longNameFile?.name ?? "none"}`);

  // /approvals needs one genuinely pending decision so its primary action
  // (通过) exists on the page.
  const approvalFolderId = (await json("POST", "/api/folders", { parentId: rootId, name: "UX-VIS-APPROVAL-" + stamp })).body?.data?.id;
  await json("PUT", `/api/folders/${approvalFolderId}/approval-policy`, { approverId: me.id, enabled: true });
  const pendingFile = await uploadTo(approvalFolderId, "vis-pending.txt", `visual pending ${stamp}\n`);
  const lock = (await json("POST", `/api/files/${pendingFile.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
  const submit = await json("POST", `/api/files/${pendingFile.fileId}/save`, {
    baseSeq: 1, lockToken: lock, data: Buffer.from(`visual pending v2 ${stamp}\n`).toString("base64"),
    idempotencyKey: "ux-visual-pending-" + stamp,
  });
  if (submit.status !== 202) throw new Error(`pending approval fixture failed: HTTP ${submit.status}`);

  const ROUTES = [
    { name: "doc", path: "/doc", wait: `()=>!!document.querySelector('table[role=grid]')` },
    { name: "trash", path: "/trash", wait: `()=>[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='恢复')` },
    { name: "org", path: "/org", wait: `()=>!!document.querySelector('input[aria-label="新账号"]')` },
    { name: "approvals", path: "/approvals", wait: `()=>[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='通过')` },
    { name: "preview", path: `/preview/${previewFile.fileId}`, wait: `()=>!!document.querySelector('[role="tablist"][data-rare-tabs]')` },
  ];

  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // ---- VIS-01/06 static governance (no browser needed) ----
  const artifacts = [];
  try {
    const scan = scanComponentGovernance();
    const hexViolations = scan.violations.filter((v) => v.kind === "hex");
    const emojiViolations = scan.violations.filter((v) => v.kind === "emoji");
    check("VIS-01 component CSS consumes tokens only (no raw hex outside the token layer)",
      hexViolations.length === 0,
      `${scan.files.length} files scanned under ${GOVERNANCE_ROOTS.join(", ")}; ${hexViolations.length} violations: ${JSON.stringify(hexViolations)}`);
    check("VIS-01/06 component CSS carries no emoji in UI strings",
      emojiViolations.length === 0,
      `${emojiViolations.length} violations: ${JSON.stringify(emojiViolations)}`);
    const governanceFile = `${EVIDENCE_DIR}/visual-governance.json`;
    writeFileSync(governanceFile, JSON.stringify({
      id: "VIS-01/06", stamp, scannedAt: new Date().toISOString(),
      roots: scan.roots, files: scan.files, violations: scan.violations, exceptions: scan.exceptions,
    }, null, 2));
    artifacts.push(governanceFile);
    console.log(`GOVERNANCE ${scan.files.length} files, ${scan.violations.length} violations, ${scan.exceptions.length} documented exceptions`);
  } catch (err) {
    check("VIS-01 component CSS governance scan completed", false, String(err?.message ?? err));
  }

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--window-size=1920,1080", "about:blank",
  ], { stdio: "ignore" });

  let cdp = null;
  const evidence = [];
  let runError = null;
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

    // authenticate the browser session once through the real login form
    await cdp.navigate(`${BASE}/login`);
    await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`, 15000);
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
    const session = await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 20000);
    check("VIS-04 browser session established", Boolean(session), await cdp.evaluate(`(()=>location.pathname)()`));

    // ---- three-viewport capture loop: one Chrome session, reused navigation ----
    for (const vp of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
      });
      for (const route of ROUTES) {
        await cdp.navigate(BASE + route.path);
        const ready = await cdp.waitFor(route.wait, 20000);
        await delay(400);

        // no horizontal document overflow
        const overflow = await cdp.evaluate(`(()=>{
          const de=document.documentElement;
          const body=document.body;
          return {scrollWidth:Math.max(de.scrollWidth,body?body.scrollWidth:0),clientWidth:de.clientWidth};})()`);
        check(`VIS-04 ${route.name} ${vp.name}: no horizontal document overflow`,
          Boolean(overflow) && overflow.scrollWidth <= overflow.clientWidth + 1, JSON.stringify(overflow));

        // the primary action sits inside the viewport
        const element = await cdp.evaluate(`(()=>{
          const el=${PRIMARY_FINDERS[route.name]};
          if(!el)return {found:false};
          const r=el.getBoundingClientRect();
          const s=getComputedStyle(el);
          return {found:true,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,
                  visible:s.display!=='none'&&s.visibility!=='hidden'};})()`);
        const elementInView = Boolean(element) && element.found && element.visible
          && element.width > 0 && element.height > 0
          && element.left >= -1 && element.top >= -1
          && element.right <= vp.width + 1 && element.bottom <= vp.height + 1;
        check(`VIS-04 ${route.name} ${vp.name}: primary action inside the viewport`,
          elementInView, `${PRIMARY_LABELS[route.name]} ${JSON.stringify(element)}`);

        // the table and breadcrumb are reachable (not clipped to zero size)
        const surfaces = await cdp.evaluate(`(()=>{
          const measure=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
            return {width:r.width,height:r.height,visible:r.width>0&&r.height>0};};
          return {crumb:measure(document.querySelector('nav.breadcrumb')||document.querySelector('.breadcrumb')),
                  table:measure(document.querySelector('table[role=grid]')||document.querySelector('table'))};})()`);
        const reachable = surfaces && surfaces.crumb && surfaces.crumb.visible
          && surfaces.table && surfaces.table.visible;
        check(`VIS-04 ${route.name} ${vp.name}: table and breadcrumb reachable`,
          Boolean(reachable), `${JSON.stringify(surfaces)} ready=${Boolean(ready)}`);

        const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const file = `${EVIDENCE_DIR}/${route.name}-${vp.name}.png`;
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        evidence.push(file);
      }
    }

    // ---- a11y metadata on /doc (fixture folder guarantees real rows) ----
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ---- VIS-03 contrast pass over the main routes (VIS-11 metadata too) ----
    for (const route of ROUTES) {
      const path = route.name === "doc" ? `/doc?folder=${visFolderId}` : route.path;
      try {
        await cdp.navigate(BASE + path);
        const ready = route.name === "doc"
          ? await cdp.waitFor(`()=>document.querySelectorAll('table[role=grid] tbody tr[data-id]').length>=1`, 20000)
          : await cdp.waitFor(route.wait, 20000);
        await delay(300);
        const pairs = await vis(cdp, { op: "texts", pairs: ROUTE_TEXT_PAIRS });
        for (const pair of pairs) reportPair(route.name, pair);
        const present = pairs.filter((p) => !p.skipped);
        check(`VIS-03 ${route.name}: every measured pair meets its WCAG threshold`,
          present.length > 0 && present.every((p) => p.ok),
          `${present.length} measured, ${present.filter((p) => !p.ok).length} failing, ${pairs.length - present.length} skipped; ready=${Boolean(ready)}`);
        artifacts.push(writeContrastEvidence(route.name, BASE + path, pairs));

        const a11y = await vis(cdp, { op: "a11y" });
        const images = a11y?.images ?? [];
        const badImages = images.filter((i) => !i.ok);
        check(`VIS-11 ${route.name}: every image or icon is aria-hidden or labelled`,
          images.length > 0 && badImages.length === 0,
          `${images.length} images/icons, ${badImages.length} unlabelled: ${JSON.stringify(badImages)}`);
        const headers = a11y?.headers ?? [];
        const badHeaders = headers.filter((h) => !h.ok);
        check(`VIS-11 ${route.name}: column headers expose scope or role`,
          headers.length > 0 && badHeaders.length === 0,
          `${headers.length} headers, ${badHeaders.length} without scope/role: ${JSON.stringify(badHeaders)}`);
      } catch (err) {
        check(`VIS-03/11 ${route.name} contrast pass completed`, false, String(err?.message ?? err));
      }
    }

    await cdp.navigate(`${BASE}/doc?folder=${visFolderId}`);
    const gridReady = await cdp.waitFor(`()=>document.querySelectorAll('table[role=grid] tbody tr[data-id]').length>=1`, 20000);
    const grid = await cdp.evaluate(`(()=>{
      const t=document.querySelector('table[role=grid]');
      if(!t)return {found:false};
      return {found:true,label:t.getAttribute('aria-label')||'',rows:t.querySelectorAll('tbody tr[data-id]').length};})()`);
    check("VIS-11 /doc: grid exposes role=grid with aria-label",
      Boolean(gridReady) && Boolean(grid?.found) && grid.label.trim().length > 0, JSON.stringify(grid));

    const rows = await cdp.evaluate(`(()=>[...document.querySelectorAll('table[role=grid] tbody tr[data-id]')]
      .map(r=>({selected:r.getAttribute('aria-selected')})))()`);
    check("VIS-11 /doc: grid rows carry aria-selected",
      Array.isArray(rows) && rows.length >= 1
      && rows.every((r) => r.selected === "true" || r.selected === "false"), JSON.stringify(rows));

    const treeState = await cdp.evaluate(`(()=>{
      const trees=[...document.querySelectorAll('ul[role=tree]')];
      return {trees:trees.length,label:trees[0]?trees[0].getAttribute('aria-label')||'':'',
              items:document.querySelectorAll('ul[role=tree] li[role=treeitem]').length};})()`);
    check("VIS-11 /doc: tree exposes role=tree with treeitems",
      treeState && treeState.trees === 1 && treeState.items >= 1 && treeState.label.trim().length > 0,
      JSON.stringify(treeState));

    const shell = await cdp.evaluate(`(()=>({
      headers:document.querySelectorAll('header.header').length,
      navs:document.querySelectorAll('header.header nav').length,
      labels:[...document.querySelectorAll('header.header nav a')].map(a=>a.textContent?.trim())}))()`);
    const navOk = shell && shell.labels.length === NAV_LABELS.length
      && NAV_LABELS.every((label, i) => shell.labels[i] === label);
    check("VIS-11 /doc: single shell nav with the full label set",
      Boolean(shell) && shell.headers === 1 && shell.navs === 1 && navOk, JSON.stringify(shell));

    // ---- VIS-02/03/07/08/11 interactive slice on /doc ----
    // The static pairs and the per-route a11y metadata were measured in the
    // contrast pass above; this block adds the pairs that only exist in an
    // interactive state (dialog, hover, selected, error notice) plus the row
    // states, the reduced-motion probe and the long-filename row. A crash
    // inside the block is one FAIL line, never a lost cleanup.
    const docPairs = [];
    const stateEvidence = { stamp, url: `${BASE}/doc?folder=${visFolderId}`, viewport: "1440x900" };
    const keepRow = `[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.querySelector('.file-name')?.textContent==='vis-keep.txt')`;
    const reportDocPair = (pair) => { docPairs.push(pair); reportPair("doc", pair); };
    try {
      // non-text boundaries that need no interaction (>=3:1)
      reportDocPair(await vis(cdp, { op: "boundary", pair: { id: "input-border", kind: "border", sel: "input:not([type=file])" } }));
      reportDocPair(await vis(cdp, { op: "boundary", pair: { id: "select-border", kind: "border", sel: "select" } }));
      reportDocPair(await vis(cdp, { op: "focusRing", id: "focus-ring-input", sel: "input:not([type=file])" }));

      // The V3 toolbar includes type + name filters. Follow all three Tab
      // stops to reach the first grid row and engage the keyboard focus ring.
      await cdp.evaluate(`(()=>{const s=document.querySelector('select[aria-label="排序方式"]');s?.focus();return Boolean(s);})()`);
      const tabStops=[];
      for(let i=0;i<3;i++){
        await keyPress(cdp, "Tab", "Tab", 9);
        tabStops.push(await cdp.evaluate(`(()=>{const a=document.activeElement;return {tag:a?.tagName,label:a?.getAttribute('aria-label')??null};})()`));
      }
      await delay(150);
      const tabLanded = await cdp.evaluate(`(()=>{const a=document.activeElement;return a&&a.tagName==='TR'?{row:true,focusVisible:a.matches(':focus-visible')}:{row:false,tag:a?a.tagName:'none'};})()`);
      const correctOrder=tabStops[0]?.label==="文件类型筛选"&&tabStops[1]?.label==="当前目录内过滤";
      check("VIS-03 doc: keyboard traverses V3 filters before the grid",correctOrder,JSON.stringify(tabStops));
      if (tabLanded.row && correctOrder) {
        reportDocPair(await vis(cdp, { op: "boundary", pair: { id: "focus-ring-row", kind: "outline", sel: "tbody tr[data-id]" } }));
      } else {
        docPairs.push({ id: "focus-ring-row", kind: "outline", skipped: true, reason: "Tab through V3 toolbar did not reach a grid row: " + JSON.stringify({tabLanded,tabStops}) });
        check("VIS-03 doc: focus-ring-row boundary contrast >= 3:1", false, JSON.stringify(tabLanded));
      }

      // hover state: a real pointer over the second row's name cell
      const hoverPoint = await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];const row=rows[1]||rows[0];const cell=row?.querySelector('.file-name');if(!cell)return null;const b=cell.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()`);
      if (hoverPoint) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverPoint.x, y: hoverPoint.y });
        await delay(250);
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "hover-row-text", sel: "tbody tr[data-id]:hover .file-name" } }));
        stateEvidence.hover = await vis(cdp, { op: "rowState" });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
        await delay(150);
      }
      stateEvidence.default = await vis(cdp, { op: "rowState" });

      // selected state: click the vis-keep row (single click selects, DI-01)
      await cdp.evaluate(`(()=>{const row=${keepRow};row?.click();return Boolean(row);})()`);
      await delay(250);
      reportDocPair(await vis(cdp, { op: "text", pair: { id: "selected-row-text", sel: "tbody tr.selected .file-name" } }));
      // Selected state is indicated by a checked, contrast-compliant control,
      // not a high-contrast perimeter around the entire dense file row.
      reportDocPair(await vis(cdp, { op: "boundary", pair: { id: "selected-checkbox-boundary", kind: "boundary", sel: "tbody tr.selected .col-select input:checked" } }));
      reportDocPair(await vis(cdp, { op: "text", pair: { id: "selection-bar-action", sel: ".selection-bar .secondary-action" } }));
      stateEvidence.selected = await vis(cdp, { op: "rowState" });

      // VIS-02: the four states have rules, and default/hover/selected are
      // distinguishable without relying on color alone where a boundary exists
      const rowRules = {
        hover: await vis(cdp, { op: "rules", pattern: "tr\\s*:\\s*hover" }),
        selected: await vis(cdp, { op: "rules", pattern: "tr\\s*\\.\\s*selected" }),
        focused: await vis(cdp, { op: "rules", pattern: "tr\\s*:\\s*focus-visible|tr\\s*\\.\\s*focused" }),
      };
      stateEvidence.rowRules = rowRules;
      check("VIS-02 /doc: row-state CSS rules exist (hover/selected/focused)",
        rowRules.hover.length > 0 && rowRules.selected.length > 0 && rowRules.focused.length > 0,
        JSON.stringify({ hover: rowRules.hover.length, selected: rowRules.selected.length, focused: rowRules.focused.length }));
      const bgs = [stateEvidence.default?.defaultBg, stateEvidence.hover?.hoverBg, stateEvidence.selected?.selectedBg];
      check("VIS-02 /doc: default, hover and selected row states are distinguishable",
        bgs.every(Boolean) && new Set(bgs).size === 3, JSON.stringify(bgs));

      // VIS-02: keyboard focus marks the focused row (and moves it). The row
      // under test is the first one in the grid, not a named fixture: under
      // updated_desc ordering the keep row can be the LAST row, where ArrowDown
      // is clamped by design and could never move. What is asserted is that the
      // focus marker follows the arrow key onto a different row with tabIndex 0.
      const firstRowName = await cdp.evaluate(`(()=>{const row=document.querySelector('tbody tr[data-id]');row?.focus();return row?.querySelector('.file-name')?.textContent??null;})()`);
      await keyPress(cdp, "ArrowDown", "ArrowDown", 40);
      await delay(250);
      const focusedState = await vis(cdp, { op: "rowState" });
      stateEvidence.focused = focusedState;
      check("VIS-02 /doc: keyboard focus marks the focused row",
        Boolean(focusedState.focusedRow) && focusedState.focusedRow.tabIndex === 0
        && focusedState.focusedRow.name !== firstRowName,
        JSON.stringify({ from: firstRowName, to: focusedState.focusedRow }));

      // rename dialog: primary button label, dialog title, accessible name,
      // then a real E_NAME_CONFLICT for the error notice
      const renameMenuTrigger=await cdp.evaluate(`(()=>{
        const row=${keepRow};
        const btn=row?.querySelector('.more-trigger');
        if(!btn)return false;btn.click();return true;})()`);
      const renameMenu=renameMenuTrigger && await cdp.waitFor(
        `()=>[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.querySelector('.menu-label')?.textContent?.trim()==='重命名')`,5000);
      if(renameMenu){
        await cdp.evaluate(`(()=>{
          const b=[...document.querySelectorAll('[role="menuitem"]')].find(
            b=>b.querySelector('.menu-label')?.textContent?.trim()==='重命名');
          b?.click();return Boolean(b);})()`);
      }
      const renameOpen = renameMenu && await cdp.waitFor(
        `()=>document.querySelector('dialog.dialog:modal .dialog-title')?.textContent==='重命名文件'`,8000);
      if (renameOpen) {
        stateEvidence.dialogName = await vis(cdp, { op: "dialog" });
        check("VIS-11 /doc: dialog exposes its accessible name",
          Boolean(stateEvidence.dialogName?.ok), JSON.stringify(stateEvidence.dialogName));
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "primary-button", sel: "dialog.dialog button.primary" } }));
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "dialog-title", sel: ".dialog-title" } }));
        await cdp.evaluate(`(()=>{
          const input=document.querySelector('#rename-input');
          if(!input)return false;
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          set.call(input,'vis-preview.txt');
          input.dispatchEvent(new Event('input',{bubbles:true}));
          const btn=[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='保存');
          btn?.click();return Boolean(btn);})()`);
        const conflict = await cdp.waitFor(`()=>{const p=document.querySelector('p.notice.error');return p?p.textContent.trim():null;}`, 10000);
        stateEvidence.renameConflictNotice = conflict;
        check("VIS-03 doc: error notice rendered for the rename conflict", Boolean(conflict), String(conflict));
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "error-notice", sel: "p.notice.error" } }));
        await keyPress(cdp, "Escape", "Escape", 27);
        await delay(300);
      } else {
        check("VIS-03 doc: rename dialog opened for the dialog pairs", false, "dialog did not open");
      }

      // delete confirmation dialog: hint, danger label, secondary action
      await cdp.evaluate(`(()=>{const row=${keepRow};row?.click();row?.focus();return Boolean(row);})()`);
      await keyPress(cdp, "Delete", "Delete", 46);
      const deleteOpen = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.textContent?.includes('删除确认'))`, 8000);
      if (deleteOpen) {
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "dialog-hint", sel: "dialog.dialog .hint" } }));
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "dialog-danger", sel: "dialog.dialog .danger" } }));
        reportDocPair(await vis(cdp, { op: "text", pair: { id: "dialog-secondary", sel: "dialog.dialog .secondary-action" } }));
        await cdp.evaluate(`(()=>{[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='取消')?.click();return true;})()`);
        await delay(300);
      } else {
        check("VIS-03 doc: delete confirmation dialog opened for the hint/danger pairs", false, "dialog did not open");
      }

      // back to the resting state, then the long-filename row (VIS-08)
      await cdp.evaluate(`(()=>{const row=${keepRow};row?.focus();return true;})()`);
      await keyPress(cdp, "Escape", "Escape", 27);
      await delay(200);
      const longName = await vis(cdp, { op: "longName", name: LONG_FILE_NAME });
      stateEvidence.longName = longName;
      check("VIS-08 /doc: long filename renders with ellipsis and the full name reachable",
        Boolean(longName?.ok),
        `${LONG_FILE_NAME.length} chars :: ${JSON.stringify(longName)}`);

      // the resting-state a11y audit (per-route checks already ran above; this
      // copy is saved as evidence for the interactive state)
      stateEvidence.a11y = await vis(cdp, { op: "a11y" });

      // VIS-07: measure what animates by default, then disable motion through
      // the real media emulation and re-measure after a reload
      const baseline = await vis(cdp, { op: "animated" });
      await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await cdp.navigate(`${BASE}/doc?folder=${visFolderId}`);
      await cdp.waitFor(`()=>document.querySelectorAll('table[role=grid] tbody tr[data-id]').length>=1`, 20000);
      await delay(300);
      const reduced = await vis(cdp, { op: "animated" });
      const media = await vis(cdp, { op: "media" });
      const emulationActive = await cdp.evaluate(`(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches)()`);
      await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] });
      const reducedRules = (media ?? []).filter((m) => /prefers-reduced-motion/.test(m.condition));
      const rulesApplying = reducedRules.filter((m) => m.hasDeclarations && (m.matches === null ? emulationActive : m.matches));
      const motionOk = emulationActive && (baseline.length > 0 ? reduced.length === 0 : rulesApplying.length > 0);
      stateEvidence.reducedMotion = {
        emulationActive,
        baselineAnimated: baseline,
        reducedAnimated: reduced,
        mediaRules: media,
        reducedMotionRules: reducedRules.map((m) => m.condition),
        rulesWithMotionDeclarations: rulesApplying.length,
        verdict: motionOk,
      };
      check("VIS-07 /doc: prefers-reduced-motion disables non-essential animation", motionOk,
        JSON.stringify({
          emulationActive,
          animatedByDefault: baseline.length,
          animatedUnderReduce: reduced.length,
          stillAnimated: reduced.slice(0, 5),
          reducedMotionRules: reducedRules.map((m) => m.condition),
          rulesWithMotionDeclarations: rulesApplying.length,
          note: baseline.length === 0
            ? "no element animates on a plain /doc load, so the reduced-motion rule itself was verified (existence + match + animation/transition declarations)"
            : "elements that animate by default were re-measured under the emulated media",
        }));
    } catch (err) {
      check("VIS-02/03/07/08/11 /doc interactive block completed", false, String(err?.message ?? err));
    } finally {
      // merge the interactive pairs into the per-route contrast evidence
      const docFile = `${EVIDENCE_DIR}/contrast-doc.json`;
      let existing = { pairs: [] };
      try { existing = JSON.parse(readFileSync(docFile, "utf8")); } catch { /* first write */ }
      const merged = [...(existing.pairs ?? []), ...docPairs];
      const present = merged.filter((p) => !p.skipped);
      writeFileSync(docFile, JSON.stringify({
        id: "VIS-03",
        route: "doc",
        url: stateEvidence.url,
        viewport: "1440x900",
        stamp,
        measuredAt: new Date().toISOString(),
        standard: "WCAG 2.x AA (DESIGN-SYSTEM-v1 §2.2/§5): body-size text >= 4.5:1; large text (>=24px or >=18.66px bold) and non-text UI boundaries >= 3:1",
        backgroundResolution: "effective background = ancestor chain with every semi-transparent layer composited over the first opaque layer (canvas default white)",
        summary: {
          measured: present.length,
          pass: present.filter((p) => p.ok).length,
          fail: present.filter((p) => !p.ok).length,
          skipped: merged.length - present.length,
        },
        pairs: merged,
      }, null, 2));
      if (!artifacts.includes(docFile)) artifacts.push(docFile);
      const stateFile = `${EVIDENCE_DIR}/visual-state-doc.json`;
      writeFileSync(stateFile, JSON.stringify({
        id: "VIS-02/07/08/11", route: "doc", stamp, measuredAt: new Date().toISOString(), ...stateEvidence,
      }, null, 2));
      if (!artifacts.includes(stateFile)) artifacts.push(stateFile);
    }

    check("VIS-04 evidence screenshots written",
      evidence.length === VIEWPORTS.length * ROUTES.length
      && evidence.every((file) => existsSync(file) && statSync(file).size > 1024),
      `${evidence.length} files in ${EVIDENCE_DIR}`);
  } catch (err) {
    runError = err;
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  // ---- cleanup (always): decide/reject the pending fixture, then purge ----
  const cleanupErrors = [];
  const attempt = async (fn) => {
    try { await fn(); } catch (err) { cleanupErrors.push(String(err?.message ?? err)); }
  };
  await attempt(async () => {
    const mine = await json("GET", "/api/approvals?scope=mine");
    const pending = (mine.body?.data ?? []).find((a) => a.fileName === "vis-pending.txt" && a.state === "pending");
    if (pending) await json("POST", `/api/approvals/${pending.id}/reject`, { comment: "visual gate cleanup" });
  });
  await attempt(async () => {
    if (visFolderId) await json("DELETE", `/api/folders/${visFolderId}`);
    if (approvalFolderId) await json("DELETE", `/api/folders/${approvalFolderId}`);
    const trash = await json("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name.includes("UX-VIS-" + stamp) || name.startsWith("vis-") || name.startsWith(LONG_FILE_PREFIX)) {
        await json("DELETE", "/api/trash/" + entry.id);
      }
    }
  });

  console.log(`SUMMARY pass=${results.length - results.filter((r) => !r.ok).length} total=${results.length}`);
  console.log(`EVIDENCE_FILES ${evidence.length} dir=${EVIDENCE_DIR}`);
  for (const file of evidence) console.log(`EVIDENCE ${file}`);
  console.log(`EVIDENCE_ARTIFACTS ${artifacts.length} dir=${EVIDENCE_DIR}`);
  for (const file of artifacts) console.log(`EVIDENCE ${file}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length || cleanupErrors.length || runError) {
    if (failed.length) console.error("UX_VISUAL_FAILED: " + failed.map((f) => f.name).join(", "));
    if (runError) console.error("run error: " + runError.message);
    if (cleanupErrors.length) console.error("UX_VISUAL_CLEANUP_FAILED: " + cleanupErrors.join(" | "));
    process.exit(1);
  }
  console.log("UX_VISUAL_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
