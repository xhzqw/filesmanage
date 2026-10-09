#!/usr/bin/env node
// Workflow gate (UX-ACCEPTANCE-v1 §3 SAFE-01/05/08, §5 WF-03/12/13/17/31, §8
// G3/G4/G5): file move + preflight API semantics, rollback / restore / approval
// comment through the real UI, and the safe text editor round-trip.
//
// This is the committed merge of the ad-hoc runs g3_api_smoke.py (ported from
// Python to Node with every assertion preserved), g4_workflow_smoke.mjs and
// g0_safe_edit_check.py (ported from Python to Node with every assertion
// preserved). The gate is independent of browser_journey_check.mjs and
// browser_business_check.mjs and does not reduce their coverage. A suite that
// crashes records one extra FAIL line naming it, and the remaining suites
// still run.
//
// Usage: node scripts/ux_workflows_check.mjs [--base http://127.0.0.1:18091]
//        [--password-file .secrets/admin.password] [--port 9361]
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
const PORT = Number(opt("port", "9361"));
const ORIGIN = BASE;

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

let sessionCookie = "";

// JSON call helper shared by the API suites (same contract as the Python
// urllib opener: JSON in, parsed JSON out, HTTP error statuses returned).
async function call(method, path, body) {
  const headers = { Origin: ORIGIN };
  let data;
  if (body !== undefined) {
    data = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, { method, headers, body: data });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Multipart upload built byte-for-byte like the Python helpers did (no
// idempotency key field; the boundary is caller-chosen per suite).
async function upload(folder, name, content, boundary) {
  const blob = new Blob([
    `--${boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folder}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`,
  ], { type: `multipart/form-data; boundary=${boundary}` });
  const res = await fetch(BASE + "/api/files", {
    method: "POST", headers: { Origin: ORIGIN, Cookie: sessionCookie }, body: blob,
  });
  return (await res.json()).data;
}

let rootId = "";

// ================= MOVE suite (g3_api_smoke.py, 16 checks) =================
async function moveSuite() {
  const src = (await call("POST", "/api/folders", { name: "UX-G3-SRC-" + stamp, parentId: rootId })).body?.data?.id;
  const dst = (await call("POST", "/api/folders", { name: "UX-G3-DST-" + stamp, parentId: rootId })).body?.data?.id;
  const uploadedIds = [];
  let failure = null;
  try {
    const payload = Buffer.from(`move payload ${stamp}\n`);
    const up = await upload(src, "g3-move.txt", payload, "----g3boundary");
    const fileId = up.fileId;
    uploadedIds.push(fileId);
    const sha = up.sha256;

    // WF-03: committed move
    let r = await call("POST", `/api/files/${fileId}/move`,
      { targetFolderId: dst, expectedFolderId: src, idempotencyKey: "g3-key-1" });
    let data = r.body?.data ?? {};
    check("WF-03 move commits", r.status === 200 && data.status === "committed"
      && data.fromFolderId === src && data.toFolderId === dst, JSON.stringify([r.status, r.body]));
    r = await call("GET", `/api/files/${fileId}`);
    check("WF-03 id/version/sha unchanged after move",
      r.body?.data?.file?.currentVersionSeq === 1 && r.body?.data?.file?.sha256 === sha, JSON.stringify(r.body?.data?.file));
    r = await call("GET", `/api/files?folder=${dst}&limit=200`);
    check("WF-03 target list contains the file", (r.body?.data?.items ?? []).some((f) => f.id === fileId), "");
    r = await call("GET", `/api/files?folder=${src}&limit=200`);
    check("WF-03 source list no longer contains the file", !(r.body?.data?.items ?? []).some((f) => f.id === fileId), "");

    // SAFE-05: idempotent replay returns the same result and moves nothing twice
    r = await call("POST", `/api/files/${fileId}/move`,
      { targetFolderId: dst, expectedFolderId: src, idempotencyKey: "g3-key-1" });
    check("SAFE-05 replay returns the same committed result", r.status === 200 && r.body?.data?.status === "committed", JSON.stringify([r.status, r.body]));
    r = await call("GET", `/api/files/${fileId}`);
    check("SAFE-05 replay did not bump the version", r.body?.data?.file?.currentVersionSeq === 1, JSON.stringify(r.body?.data?.file));

    // CAS: stale expectedFolderId
    const up2 = await upload(src, "g3-cas.txt", Buffer.from("cas\n"), "----g3boundary");
    uploadedIds.push(up2.fileId);
    r = await call("POST", `/api/files/${up2.fileId}/move`,
      { targetFolderId: dst, expectedFolderId: "folder_stale", idempotencyKey: "g3-key-2" });
    check("CAS stale expectedFolderId -> 409 E_VERSION_CONFLICT",
      r.status === 409 && r.body?.error?.code === "E_VERSION_CONFLICT", JSON.stringify([r.status, r.body]));
    r = await call("GET", `/api/files?folder=${src}&limit=200`);
    check("CAS rejection left the file in place", (r.body?.data?.items ?? []).some((f) => f.id === up2.fileId), "");

    // same-folder target
    r = await call("POST", `/api/files/${up2.fileId}/move`,
      { targetFolderId: src, expectedFolderId: src, idempotencyKey: "g3-key-3" });
    check("same-folder target -> 409 E_MOVE_CONFLICT",
      r.status === 409 && r.body?.error?.code === "E_MOVE_CONFLICT", JSON.stringify([r.status, r.body]));

    // name conflict in target: a second file in src carries the name that already
    // lives in dst (the moved file), so moving it must collide
    const upConflict = await upload(src, "g3-move.txt", Buffer.from("dup\n"), "----g3boundary");
    uploadedIds.push(upConflict.fileId);
    r = await call("POST", `/api/files/${upConflict.fileId}/move`,
      { targetFolderId: dst, expectedFolderId: src, idempotencyKey: "g3-key-4" });
    check("name conflict in target -> 409 E_NAME_CONFLICT",
      r.status === 409 && r.body?.error?.code === "E_NAME_CONFLICT", JSON.stringify([r.status, r.body]));
    r = await call("GET", `/api/files?folder=${src}&limit=200`);
    check("name conflict left the file in place", (r.body?.data?.items ?? []).some((f) => f.id === upConflict.fileId), "");

    // missing target
    r = await call("POST", `/api/files/${up2.fileId}/move`,
      { targetFolderId: "folder_missing", expectedFolderId: src, idempotencyKey: "g3-key-5" });
    check("missing target -> 404 E_NOT_FOUND", r.status === 404 && r.body?.error?.code === "E_NOT_FOUND", JSON.stringify([r.status, r.body]));

    // preflight: ready shape, no writes
    const up3 = await upload(src, "g3-pre.txt", Buffer.from("pre\n"), "----g3boundary");
    uploadedIds.push(up3.fileId);
    r = await call("POST", "/api/moves/preflight",
      { resources: [{ kind: "file", id: up3.fileId }], targetFolderId: dst, mode: "all_or_nothing" });
    const pf = r.body?.data ?? {};
    check("preflight ready shape", r.status === 200 && pf.status === "ready" && pf.allowedCount === 1
      && Boolean(pf.candidateRevision) && Array.isArray(pf.conflicts) && Boolean(pf.targetSummary), JSON.stringify([r.status, r.body]));
    r = await call("GET", `/api/files?folder=${src}&limit=200`);
    check("preflight wrote nothing", (r.body?.data?.items ?? []).some((f) => f.id === up3.fileId), "");

    // preflight: conflict for the name that already exists in dst
    r = await call("POST", "/api/moves/preflight",
      { resources: [{ kind: "file", id: upConflict.fileId }], targetFolderId: dst, mode: "all_or_nothing" });
    const pf2 = r.body?.data ?? {};
    const codes = (pf2.conflicts ?? []).map((c) => c.code);
    check("preflight reports the name conflict", pf2.status === "conflict" && codes.includes("E_NAME_CONFLICT"), JSON.stringify([r.status, r.body]));

    // preflight: hidden/missing target indistinguishable
    r = await call("POST", "/api/moves/preflight",
      { resources: [{ kind: "file", id: up3.fileId }], targetFolderId: "folder_missing", mode: "all_or_nothing" });
    check("preflight hidden target answers 404 like missing", r.status === 404 && r.body?.error?.code === "E_NOT_FOUND", JSON.stringify([r.status, r.body]));
  } catch (err) {
    failure = err;
  }
  // cleanup (always): delete the drill files, then the folders and their trash
  try {
    for (const fid of uploadedIds) {
      if (fid) await call("DELETE", `/api/files/${fid}`);
    }
    const dstList = await call("GET", `/api/files?folder=${dst}&limit=200`);
    for (const f of dstList.body?.data?.items ?? []) await call("DELETE", `/api/files/${f.id}`);
    if (src) await call("DELETE", `/api/folders/${src}`);
    if (dst) await call("DELETE", `/api/folders/${dst}`);
    const trash = await call("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name.includes("UX-G3-SRC-" + stamp) || name.includes("UX-G3-DST-" + stamp) || name.startsWith("g3-")) {
        await call("DELETE", "/api/trash/" + entry.id);
      }
    }
  } catch (err) {
    if (!failure) failure = err;
  }
  if (failure) throw failure;
}

// ================= WORKFLOW suite (g4_workflow_smoke.mjs, 15 checks) =================
async function workflowSuite() {
  const tree = await call("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const me = (await call("GET", "/api/me")).body?.data;
  const folderId = (await call("POST", "/api/folders", { parentId: root.id, name: "UX-G4-" + stamp })).body?.data?.id;

  let failure = null;
  const json = async (method, path, body) => call(method, path, body);
  const uploadKeyed = async (name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", name + "-" + stamp);
    return (await (await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: sessionCookie }, body: form })).json()).data;
  };

  let chrome = null;
  let cdp = null;
  try {
    const v1 = await uploadKeyed("g4-roll.txt", `v1 ${stamp}\n`);
    // create v2 through the real save path (lock + base64 payload)
    const lock = (await json("POST", `/api/files/${v1.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
    await json("POST", `/api/files/${v1.fileId}/save`, {
      baseSeq: 1, lockToken: lock, data: btoa(`v2 ${stamp}\n`), idempotencyKey: "g4-save-" + stamp,
    });

    chrome = spawn("/usr/bin/google-chrome", [
      "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
      "--disable-gpu", "--window-size=1440,900", "about:blank",
    ], { stdio: "ignore" });
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

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
    await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`);

    // ---- WF-12..13: rollback appends a new version with the old content ----
    await cdp.navigate(`${BASE}/preview/${v1.fileId}`);
    const versionsReady = await cdp.waitFor(`()=>document.querySelectorAll('.table tbody tr').length>=2`, 20000);
    check("preview lists both versions", Boolean(versionsReady), String(versionsReady));
    const rollbackButtons = await cdp.evaluate(`(()=>[...document.querySelectorAll('.table tbody tr')].map(tr=>{
      const btn=[...tr.querySelectorAll('button')].find(b=>b.textContent?.trim()==='回滚到此版本');
      return btn?{seq:tr.textContent?.match(/v(\\d+)/)?.[1],disabled:btn.disabled}:null;}).filter(Boolean))()`);
    check("WF-12 rollback action offered for non-current versions",
      Array.isArray(rollbackButtons) && rollbackButtons.length === 1 && rollbackButtons[0].seq === "1" && rollbackButtons[0].disabled === false,
      JSON.stringify(rollbackButtons));
    await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('.table tbody tr')];const btn=[...rows[0].querySelectorAll('button')].find(b=>b.textContent?.trim()==='回滚到此版本');btn?.click();return Boolean(btn);})()`);
    const rollbackOpen = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));return Boolean(d);}`, 8000);
    check("WF-12 rollback dialog explains append-only semantics", rollbackOpen === true, String(rollbackOpen));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));const input=d.querySelector('#rollback-reason');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(input,'G4 冒烟回滚');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认回滚')?.click();return true;})()`);
    const committed = await cdp.waitFor(`()=>{const rows=[...document.querySelectorAll('.table tbody tr')];return rows.length>=3&&rows.some(r=>r.textContent?.includes('回滚'));}`, 20000);
    check("WF-13 rollback appends a new version row", committed === true, String(committed));
    const bytes = await (await fetch(`${BASE}/api/files/${v1.fileId}/bytes`, { headers: { Cookie: sessionCookie } })).text();
    check("WF-13 rolled-back content is the source version bytes", bytes === `v1 ${stamp}\n`, JSON.stringify(bytes));
    const meta = (await json("GET", `/api/files/${v1.fileId}`)).body?.data;
    check("WF-13 current seq advanced and history intact",
      meta?.file?.currentVersionSeq === 3 && (meta?.versions ?? []).length >= 3, JSON.stringify(meta?.file));

    // ---- WF-17: restore from trash through the dialog ----
    const del = await json("DELETE", `/api/files/${v1.fileId}`);
    check("file moved to trash for the restore flow", del.status === 200, String(del.status));
    await cdp.navigate(`${BASE}/trash`);
    const trashRow = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('g4-roll.txt'))`, 20000);
    check("trash lists the file", Boolean(trashRow), String(trashRow));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('g4-roll.txt'));[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='恢复')?.click();return true;})()`);
    const restoreReady = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));return d&&d.textContent?.includes('目标位置')?d.textContent:false;}`, 15000);
    const restoreInfo = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));return d?d.textContent:null;})()`);
    check("WF-17 restore dialog shows original and target location",
      typeof restoreReady === "string" && restoreInfo?.includes("原位置") && restoreInfo?.includes("目标位置"), String(restoreInfo?.slice(0, 120)));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认恢复')?.click();return true;})()`);
    const restored = await cdp.waitFor(`()=>![...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('g4-roll.txt'))`, 20000);
    check("WF-17 restore removes the file from the trash list", restored === true, String(restored));
    const back = await json("GET", `/api/files?folder=${folderId}&limit=200`);
    check("WF-17 restored file is back in its folder",
      (back.body?.data?.items ?? []).some((f) => f.name === "g4-roll.txt"), "");

    // ---- WF-31: approval decision with a custom comment ----
    await json("PUT", `/api/folders/${folderId}/approval-policy`, { approverId: me.id, enabled: true });
    const v2file = await uploadKeyed("g4-approve.txt", `approve ${stamp}\n`);
    const lock2 = (await json("POST", `/api/files/${v2file.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
    const submit = await json("POST", `/api/files/${v2file.fileId}/save`, {
      baseSeq: 1, lockToken: lock2, data: btoa(`approve2 ${stamp}\n`), idempotencyKey: "g4-approve-" + stamp,
    });
    check("approval-routed save returns 202 pending", submit.status === 202, String(submit.status));
    await cdp.navigate(`${BASE}/approvals`);
    const pendingRow = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('g4-approve.txt'))`, 20000);
    check("approval inbox lists the pending decision", Boolean(pendingRow), String(pendingRow));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('g4-approve.txt'));const input=row.querySelector('input[aria-label]');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(input,'G4 冒烟审批意见');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('g4-approve.txt'));[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过')?.click();return true;})()`);
    const decided = await cdp.waitFor(`()=>{const rows=[...document.querySelectorAll('tbody tr')];return rows.some(tr=>tr.textContent?.includes('g4-approve.txt')&&tr.textContent?.includes('G4 冒烟审批意见'));}`, 20000);
    check("WF-31 custom comment ships with the decision", decided === true, String(decided));
    const afterApprove = await json("GET", `/api/files/${v2file.fileId}`);
    check("approval commits the new version",
      afterApprove.body?.data?.file?.currentVersionSeq === 2, JSON.stringify(afterApprove.body?.data?.file));
  } catch (err) {
    failure = err;
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
  }

  // cleanup (always)
  try {
    await json("DELETE", `/api/folders/${folderId}`);
    const trash = await json("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name.includes("UX-G4-" + stamp) || name.startsWith("g4-")) {
        await json("DELETE", "/api/trash/" + entry.id);
      }
    }
  } catch (err) {
    if (!failure) failure = err;
  }
  if (failure) throw failure;
}

// ================= SAFE-EDIT suite (g0_safe_edit_check.py, 10 checks) =================
// Python mirror of web/src/features/documents/safeEdit.ts assessEditable.
function assessEditable(preview) {
  if (!preview.textual) return [false, "not textual"];
  if (preview.truncated) return [false, "truncated"];
  if (!preview.byteMeta.printable) return [false, "not printable"];
  if (typeof preview.rawBase64 !== "string") return [false, "no rawBase64"];
  if (preview.byteMeta.eol === "mixed") return [false, "mixed eol"];
  const raw = Buffer.from(preview.rawBase64, "base64");
  let text;
  try {
    // ignoreBOM keeps U+FEFF in the string, matching Python's raw.decode("utf-8").
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return [false, "not utf-8"];
  }
  if (preview.byteMeta.hasBom) {
    if (!text.startsWith("\ufeff")) return [false, "bom missing"];
    text = text.slice(1);
  }
  const body = preview.byteMeta.hasBom ? raw.subarray(3) : raw;
  if (!Buffer.from(text, "utf8").equals(body)) return [false, "round-trip mismatch"];
  return [true, { text, eol: preview.byteMeta.eol, hasBom: preview.byteMeta.hasBom }];
}

// Python mirror of encodeEditedText.
function encodeEdited(text, eol, hasBom) {
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (eol === "crlf") normalized = normalized.replace(/\n/g, "\r\n");
  if (hasBom) normalized = "\ufeff" + normalized;
  return Buffer.from(normalized, "utf8").toString("base64");
}

async function safeEditSuite() {
  let failure = null;
  let folderId = "";
  try {
    // isolated test folder (fixed name; any earlier copy is removed first)
    const tree = await call("GET", "/api/folders/tree");
    for (const f of tree.body?.data ?? []) {
      if (f.name === "UX-G0-SAFE-EDIT-TEST") await call("DELETE", "/api/folders/" + f.id);
    }
    const created = await call("POST", "/api/folders", { name: "UX-G0-SAFE-EDIT-TEST", parentId: "folder_root" });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`folder create failed: ${created.status} ${JSON.stringify(created.body)}`);
    }
    folderId = created.body.data.id;

    const uploadG0 = (name, content) => upload(folderId, name, content, "----g0boundary");

    // --- case 1: BOM + CRLF + trailing newline, small text file ---
    const original = Buffer.from("\ufeffline one\r\nline two 中文\r\nlast\r\n", "utf8");
    const up = await uploadG0("g0-bom-crlf.txt", original);
    const fileId = up.fileId;
    let r = await call("GET", `/api/files/${fileId}/preview`);
    const pv = r.body?.data;
    const [ok, value] = assessEditable(pv);
    check("SAFE-01 bom+crlf file assessed editable", ok, typeof value === "string" ? value : JSON.stringify(value));
    check("preview.byteMeta facts", pv.byteMeta.hasBom && pv.byteMeta.eol === "crlf"
      && pv.byteMeta.endsWithNewline && pv.textual && !pv.truncated, JSON.stringify(pv.byteMeta));
    // untouched re-encode must reproduce the exact original bytes
    check("SAFE-08 byte-exact round-trip", Buffer.from(encodeEdited(value.text, value.eol, value.hasBom), "base64").equals(original));
    // real save with the re-encoded payload must keep the content SHA identical
    r = await call("GET", `/api/files/${fileId}`);
    const baseSeq = r.body?.data?.file?.currentVersionSeq;
    r = await call("POST", `/api/files/${fileId}/lock`, { baseSeq });
    if (r.status !== 200 && r.status !== 201) throw new Error(`acquire lock failed: ${r.status} ${JSON.stringify(r.body)}`);
    const lockToken = r.body?.data?.lockToken;
    r = await call("POST", `/api/files/${fileId}/save`, {
      baseSeq, lockToken,
      data: encodeEdited(value.text, value.eol, value.hasBom),
      idempotencyKey: "g0-roundtrip-1",
    });
    const saved = r.body?.data ?? {};
    check("SAFE-01 save committed", r.status === 200 && saved.status === "committed", JSON.stringify([r.status, r.body]));
    check("SAFE-08 saved sha256 equals original sha256", saved.sha256 === up.sha256, JSON.stringify([saved.sha256, up.sha256]));

    // --- case 2: > 256 KiB text file must be blocked (truncated) ---
    const big = Buffer.from(("x".repeat(100) + "\n").repeat(3000), "utf8"); // ~303 KiB
    const up2 = await uploadG0("g0-big.txt", big);
    r = await call("GET", `/api/files/${up2.fileId}/preview`);
    const pv2 = r.body?.data;
    const [ok2, why2] = assessEditable(pv2);
    check("SAFE-01 oversized text blocked", !ok2 && why2 === "truncated" && pv2.truncated, why2);

    // --- case 3: binary content (nul bytes) must be blocked ---
    const up3 = await uploadG0("g0-binary.txt", Buffer.from([0x61, 0x62, 0x63, 0x00, 0x64, 0x65, 0x66]));
    r = await call("GET", `/api/files/${up3.fileId}/preview`);
    const pv3 = r.body?.data;
    const [ok3, why3] = assessEditable(pv3);
    check("SAFE-01 binary (nul in .txt) blocked", !ok3 && why3 === "not printable", JSON.stringify([why3, pv3.byteMeta]));

    // --- case 4: mixed EOL must be blocked ---
    const up4 = await uploadG0("g0-mixed.txt", Buffer.from("a\r\nb\nc\n", "utf8"));
    r = await call("GET", `/api/files/${up4.fileId}/preview`);
    const pv4 = r.body?.data;
    const [ok4, why4] = assessEditable(pv4);
    check("SAFE-01 mixed EOL blocked", !ok4 && why4 === "mixed eol", JSON.stringify([why4, pv4.byteMeta]));

    // --- case 5: empty file editable and round-trips ---
    const up5 = await uploadG0("g0-empty.txt", Buffer.from(""));
    r = await call("GET", `/api/files/${up5.fileId}/preview`);
    const pv5 = r.body?.data;
    const [ok5, value5] = assessEditable(pv5);
    check("SAFE-01 empty file editable", ok5 && value5.text === "", JSON.stringify(value5));

    // --- cleanup: delete test files and folder (trash), then purge ---
    for (const fid of [fileId, up2.fileId, up3.fileId, up4.fileId, up5.fileId]) {
      r = await call("DELETE", `/api/files/${fid}`);
      if (r.status !== 200) throw new Error(`file delete failed: ${fid} ${r.status} ${JSON.stringify(r.body)}`);
    }
    let trash = await call("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? ""), oldName = String(entry.oldName ?? "");
      if (name.startsWith("g0-") || oldName.startsWith("g0-")) {
        await call("DELETE", "/api/trash/" + entry.id);
      }
    }
    r = await call("DELETE", `/api/folders/${folderId}`);
    check("cleanup folder removed", r.status === 200, JSON.stringify([r.status, r.body]));
    trash = await call("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      if (entry.name === "UX-G0-SAFE-EDIT-TEST") {
        await call("DELETE", "/api/trash/" + entry.id);
      }
    }
    folderId = "";
  } catch (err) {
    failure = err;
  }
  // reap the fixed-name folder even after a mid-suite failure
  if (folderId) {
    try {
      await call("DELETE", `/api/folders/${folderId}`);
      const trash = await call("GET", "/api/trash");
      for (const entry of trash.body?.data ?? []) {
        if (entry.name === "UX-G0-SAFE-EDIT-TEST") await call("DELETE", "/api/trash/" + entry.id);
      }
    } catch (err) {
      if (!failure) failure = err;
    }
  }
  if (failure) throw failure;
}

// Minimal CDP client for the workflow suite (same shape as the other gates).
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
  close() { this.ws.close(); }
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  const setCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith("fm_session="))?.split(";")[0];
  if (loginRes.status !== 200 || !loginBody?.ok) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`);
  }
  if (!setCookie) throw new Error("login response carried no fm_session cookie");
  sessionCookie = setCookie;

  const tree = await call("GET", "/api/folders/tree");
  rootId = (tree.body?.data ?? []).find((f) => f.id === "folder_root")?.id
    ?? (tree.body?.data ?? []).find((f) => !f.parentId)?.id;

  const runSuite = async (label, fn) => {
    try { await fn(); }
    catch (err) { check(`${label} suite completed`, false, String(err?.message ?? err)); }
  };
  await runSuite("MOVE", moveSuite);
  await runSuite("WORKFLOW", workflowSuite);
  await runSuite("SAFE-EDIT", safeEditSuite);

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("UX_WORKFLOWS_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("UX_WORKFLOWS_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
