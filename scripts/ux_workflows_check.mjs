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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9361"));
const ORIGIN = BASE;

assertIsolatedFixtures({base:BASE,args,explicitBase:args.includes("--base")});

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());
// Each browser suite needs an isolated Chrome profile, so it cannot reuse
// another suite's session or cached authentication.
const chromeProfiles = [];
function isolatedChromeProfile(){
  const path=mkdtempSync(join(tmpdir(),"filesmanage-wf-chrome-"));
  chromeProfiles.push(path);
  return path;
}
process.once("exit",()=>{
  for(const path of chromeProfiles){
    try{rmSync(path,{recursive:true,force:true,maxRetries:2});}catch{}
  }
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

let sessionCookie = "";

// JSON call helper shared by the API suites (same contract as the Python
// urllib opener: JSON in, parsed JSON out, HTTP error statuses returned).
async function call(method, path, body) {
  const headers = { Origin: ORIGIN, Cookie: sessionCookie };
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
  const ROLL_NAME = `g4-roll-${stamp}.txt`;
  const APPROVE_NAME = `g4-approve-${stamp}.txt`;
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
    const v1 = await uploadKeyed(ROLL_NAME, `v1 ${stamp}\n`);
    // create v2 through the real save path (lock + base64 payload)
    const lock = (await json("POST", `/api/files/${v1.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
    await json("POST", `/api/files/${v1.fileId}/save`, {
      baseSeq: 1, lockToken: lock, data: btoa(`v2 ${stamp}\n`), idempotencyKey: "g4-save-" + stamp,
    });

    chrome = spawn("/usr/bin/google-chrome", [
      "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${isolatedChromeProfile()}`, "--no-sandbox",
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
    const versionsTabReady=await cdp.waitFor(`()=>!!document.querySelector('#file-tab-versions')`,20000);
    if(!versionsTabReady)throw Error("preview did not expose the version-history tab");
    await cdp.evaluate(`(()=>{document.querySelector('#file-tab-versions').click();return true;})()`);
    const versionsReady = await cdp.waitFor(`()=>document.querySelectorAll('.file-versions-table tbody tr').length>=2`, 20000);
    check("preview lists both versions", Boolean(versionsReady), String(versionsReady));
    const rollbackButtons = await cdp.evaluate(`(()=>[...document.querySelectorAll('.file-versions-table tbody tr')].map(tr=>{
      const btn=[...tr.querySelectorAll('button')].find(b=>b.textContent?.trim()==='回滚到此版本');
      return btn?{seq:tr.textContent?.match(/v(\\d+)/)?.[1],disabled:btn.disabled}:null;}).filter(Boolean))()`);
    check("WF-12 rollback action offered for non-current versions",
      Array.isArray(rollbackButtons) && rollbackButtons.length === 1 && rollbackButtons[0].seq === "1" && rollbackButtons[0].disabled === false,
      JSON.stringify(rollbackButtons));
    const rollbackClicked=await cdp.evaluate(`(()=>{const btn=[...document.querySelectorAll('.file-versions-table tbody tr button')].find(b=>b.textContent?.trim()==='回滚到此版本'&&!b.disabled);btn?.click();return Boolean(btn);})()`);
    if(!rollbackClicked)throw Error("no enabled rollback action in the version-history tab");
    const rollbackOpen = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));return Boolean(d);}`, 8000);
    check("WF-12 rollback dialog explains append-only semantics", rollbackOpen === true, String(rollbackOpen));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));const input=d.querySelector('#rollback-reason');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(input,'G4 冒烟回滚');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    // The commit control is a hold-to-confirm (PRECISION-WORKBENCH-V2-SPEC 6.3): a bare click()
    // only presses it, so the gate drives the real gesture - pointerdown, then let the 800ms fill
    // run to completion - exactly as a user would. The assertions below are unchanged.
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('回滚将生成新版本'));const b=[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认回滚');b?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));return Boolean(b);})()`);
    await delay(1200);
    const committed = await cdp.waitFor(`()=>{const rows=[...document.querySelectorAll('.file-versions-table tbody tr')];return rows.length>=3&&rows.some(r=>r.textContent?.includes('回滚'));}`, 20000);
    check("WF-13 rollback appends a new version row", committed === true, String(committed));
    const bytes = await (await fetch(`${BASE}/api/files/${v1.fileId}/bytes`, { headers: { Cookie: sessionCookie } })).text();
    check("WF-13 rolled-back content is the source version bytes", bytes === `v1 ${stamp}\n`, JSON.stringify(bytes));
    const meta = (await json("GET", `/api/files/${v1.fileId}`)).body?.data;
    check("WF-13 current seq advanced and history intact",
      meta?.file?.currentVersionSeq === 3 && (meta?.versions ?? []).length >= 3, JSON.stringify(meta?.file));

    // G2: changes committed in another tab or over an API client cannot
    // dispatch this page's local event. Returning focus must revalidate the
    // server-side filename and prevent stale preview actions after deletion.
    const externalName="g4-external-"+stamp+".txt";
    const externalRename=await json("PATCH",`/api/files/${v1.fileId}`,{name:externalName});
    await cdp.evaluate("(()=>{window.dispatchEvent(new Event('focus'));return true;})()");
    const renamedOnReturn=await cdp.waitFor(`()=>document.querySelector('.file-workbench-title h1')?.textContent===${JSON.stringify(externalName)}`,16000);
    check("G2 preview focus revalidates an external rename",externalRename.status===200&&renamedOnReturn===true,String(renamedOnReturn));
    await delay(900);
    const renameBack=await json("PATCH",`/api/files/${v1.fileId}`,{name:ROLL_NAME});
    await cdp.evaluate("(()=>{window.dispatchEvent(new Event('focus'));return true;})()");
    const restoredName=await cdp.waitFor(`()=>document.querySelector('.file-workbench-title h1')?.textContent===${JSON.stringify(ROLL_NAME)}`,16000);
    check("G2 preview title returns to server name",renameBack.status===200&&restoredName===true,String(restoredName));

    // ---- WF-17: restore from trash through the dialog ----
    const del = await json("DELETE", `/api/files/${v1.fileId}`);
    check("file moved to trash for the restore flow", del.status === 200, String(del.status));
    await delay(900);
    await cdp.evaluate("(()=>{window.dispatchEvent(new Event('focus'));return true;})()");
    const stalePreviewGone=await cdp.waitFor(`()=>!!document.querySelector('.file-workbench-error [role=alert]')&&!document.querySelector('.file-workbench-actions button')`,16000);
    check("G2 preview removes stale content and actions after external deletion",stalePreviewGone===true,String(stalePreviewGone));
    await cdp.navigate(`${BASE}/trash`);
    const trashRow = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes(${JSON.stringify(ROLL_NAME)}))`, 20000);
    check("trash lists the file", Boolean(trashRow), String(trashRow));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes(${JSON.stringify(ROLL_NAME)}));[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='恢复')?.click();return true;})()`);
    const restoreReady = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));return d&&d.textContent?.includes('目前位置')?d.textContent:false;}`, 15000);
    const restoreInfo = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));return d?d.textContent:null;})()`);
    check("WF-17 restore dialog shows deleted and destination location",
      typeof restoreReady === "string" && restoreInfo?.includes("删除时位置") && restoreInfo?.includes("目前位置") && restoreInfo?.includes(ROLL_NAME),
      String(restoreInfo?.slice(0, 150)));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认恢复')?.click();return true;})()`);
    const restored = await cdp.waitFor(`()=>![...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes(${JSON.stringify(ROLL_NAME)}))`, 20000);
    check("WF-17 restore removes the file from the trash list", restored === true, String(restored));
    const back = await json("GET", `/api/files?folder=${folderId}&limit=200`);
    check("WF-17 restored file is back in its folder",
      (back.body?.data?.items ?? []).some((f) => f.name === ROLL_NAME), "");

    // ---- WF-31: approval decision with a custom comment ----
    await json("PUT", `/api/folders/${folderId}/approval-policy`, { approverId: me.id, enabled: true });
    const v2file = await uploadKeyed(APPROVE_NAME, `approve ${stamp}\n`);
    const lock2 = (await json("POST", `/api/files/${v2file.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
    const submit = await json("POST", `/api/files/${v2file.fileId}/save`, {
      baseSeq: 1, lockToken: lock2, data: btoa(`approve2 ${stamp}\n`), idempotencyKey: "g4-approve-" + stamp,
    });
    check("approval-routed save returns 202 pending", submit.status === 202, String(submit.status));
    await cdp.navigate(`${BASE}/approvals`);
    const pendingRow = await cdp.waitFor(`()=>[...document.querySelectorAll('.approval-table tbody tr')].some(tr=>tr.textContent?.includes(${JSON.stringify(APPROVE_NAME)}))`, 20000);
    check("approval inbox lists the pending decision", Boolean(pendingRow), String(pendingRow));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.approval-table tbody tr')].find(tr=>tr.textContent?.includes(${JSON.stringify(APPROVE_NAME)}));[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过')?.click();return true;})()`);
    const approvalDialog = await cdp.waitFor(`()=>Boolean(document.querySelector('dialog.approval-decision-dialog[open] textarea'))`, 10000);
    check("WF-31 decision opens the comment dialog", approvalDialog === true, String(approvalDialog));
    await cdp.evaluate(`(()=>{const input=document.querySelector('dialog.approval-decision-dialog[open] textarea');const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(input,'G4 冒烟审批意见');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await cdp.evaluate(`(()=>{const dialog=document.querySelector('dialog.approval-decision-dialog[open]');[...dialog.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过审批')?.click();return true;})()`);
    await cdp.waitFor(`()=>Boolean(document.querySelector('#approval-tab-mine'))`, 20000);
    await cdp.evaluate(`(()=>{document.querySelector('#approval-tab-mine')?.click();return true;})()`);
    const decided = await cdp.waitFor(`()=>{const rows=[...document.querySelectorAll('.approval-table tbody tr')];return rows.some(tr=>tr.textContent?.includes(${JSON.stringify(APPROVE_NAME)})&&tr.textContent?.includes('G4 冒烟审批意见'));}`, 20000);
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
  async key(key, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  close() { this.ws.close(); }
}

// ================= MOVEUI suite (WF-01..06 through the real UI) =================
async function moveUiSuite() {
  const stamp = String(Date.now());
  const tree = await call("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const mk = async (name) => (await call("POST", "/api/folders", { name, parentId: root.id })).body?.data?.id;
  const srcId = await mk(`MV-SRC-${stamp}`);
  const dstId = await mk(`MV-DST-${stamp}`);
  const otherId = await mk(`MV-OTHER-${stamp}`);
  const childId = await mk(`MV-CHILD-${stamp}`);
  await call("POST", "/api/folders", { name: `MV-GRAND-${stamp}`, parentId: childId });
  const uploadKeyed = async (folder, name) => {
    const form = new FormData();
    form.set("folderId", folder);
    form.set("file", new Blob([`mv ${name} ${stamp}\n`]), name);
    form.set("idempotencyKey", `${folder}-${name}-${stamp}`);
    return (await (await fetch(`${BASE}/api/files`, { method: "POST", headers: { Origin: ORIGIN, Cookie: sessionCookie }, body: form })).json()).data;
  };
  const file = await uploadKeyed(srcId, "mv-file.txt");
  await uploadKeyed(dstId, "mv-dup.txt");
  await uploadKeyed(srcId, "mv-dup.txt");

  let chrome = null;
  let cdp = null;
  try {
    chrome = spawn("/usr/bin/google-chrome", [
      "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${isolatedChromeProfile()}`, "--no-sandbox",
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
    await cdp.navigate(`${BASE}/doc?folder=${srcId}`);
    const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=2`);
    check("source folder files listed", Boolean(rowsReady), String(rowsReady));

    const picker = (fn) => cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));${fn};})()`);
    // The picker tree starts collapsed, so targets are chosen through the
    // search box (also exercising the contract's search clause).
    const searchSelect = async (name) => {
      await picker(`const input=d.querySelector('.folder-picker-search');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
      await delay(400);
      const clicked = await picker(`const btn=[...d.querySelectorAll('.folder-picker-result')].find(b=>b.textContent?.includes(${JSON.stringify(name)}));btn?.click();return Boolean(btn);`);
      await delay(300);
      return clicked;
    };

    // WF-01: row menu -> 移动到… opens the picker
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('mv-file.txt'));row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return Boolean(row);})()`);
    await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`);
    const hasMove = await cdp.evaluate(`(()=>[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent?.trim()==='移动到…'))()`);
    check("WF-01 row menu offers 移动到…", hasMove === true, String(hasMove));
    await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='移动到…');item?.click();return Boolean(item);})()`);
    const pickerOpen = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 8000);
    check("WF-01 picker dialog opens with the visible tree", pickerOpen === true, String(pickerOpen));

    // WF-02: the file's own folder is an invalid target with a reason
    const ownPicked = await searchSelect(`MV-SRC-${stamp}`);
    const invalidShown = await picker(`return d.textContent?.includes('文件已在该目录')||false;`);
    check("WF-02 own folder is invalid with a reason", ownPicked === true && invalidShown === true, `picked=${ownPicked} reason=${invalidShown}`);

    // WF-03: pick a clean target, preflight, commit
    const dstPicked = await searchSelect(`MV-DST-${stamp}`);
    const candidate = await picker(`return d.querySelector('.folder-picker-candidate')?.textContent||'';`);
    check("candidate shows the full visible path", dstPicked === true && candidate.includes(`MV-DST-${stamp}`), String(candidate));
    let btn = await picker(`const b=[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='检查并继续');return b?{disabled:b.disabled}:null;`);
    check("检查并继续 enabled with a candidate", btn && btn.disabled === false, JSON.stringify(btn));
    await picker(`[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='检查并继续')?.click();return true;`);
    const ready = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));const b=d?[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动'):null;return b&&!b.disabled?true:false;}`, 15000);
    check("WF-03 preflight ready enables 确认移动", ready === true, String(ready));
    // WF-05: switching the target invalidates the previous preflight
    await searchSelect(`MV-OTHER-${stamp}`);
    btn = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));const b=d?[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动'):null;return b?{disabled:b.disabled}:null;})()`);
    check("WF-05 switching target re-disables 确认移动", btn && btn.disabled === true, JSON.stringify(btn));
    await searchSelect(`MV-DST-${stamp}`);
    await picker(`[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='检查并继续')?.click();return true;`);
    const rechecked = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));const b=d?[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动'):null;return b&&!b.disabled?true:false;}`, 15000);
    check("WF-05 re-checking the new target re-enables 确认移动", rechecked === true, String(rechecked));
    await picker(`[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动')?.click();return true;`);
    const moved = await cdp.waitFor(`()=>![...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 20000);
    check("WF-03 dialog closes after commit", moved === true, String(moved));
    let list = await call("GET", `/api/files?folder=${dstId}&limit=200`);
    check("WF-03 file is in the target folder", (list.body?.data?.items ?? []).some((f) => f.name === "mv-file.txt"), "");
    list = await call("GET", `/api/files?folder=${srcId}&limit=200`);
    check("WF-03 file left the source folder", !(list.body?.data?.items ?? []).some((f) => f.name === "mv-file.txt"), "");

    // WF-05/conflict: the duplicate name must be reported by the preflight
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('mv-dup.txt'));row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return Boolean(row);})()`);
    await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`);
    await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='移动到…');item?.click();return Boolean(item);})()`);
    await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 8000);
    await searchSelect(`MV-DST-${stamp}`);
    await picker(`[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='检查并继续')?.click();return true;`);
    const conflictNotice = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));return d&&(d.textContent?.includes('同名')||d.textContent?.includes('冲突'))?d.textContent:false;}`, 15000);
    check("WF-05 name conflict reported, no silent commit", Boolean(conflictNotice), String(conflictNotice).slice(0, 120));
    const confirmLocked = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));const b=d?[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动'):null;return b?b.disabled:'no-button';})()`);
    check("WF-05 conflict keeps 确认移动 disabled", confirmLocked === true, String(confirmLocked));
    await cdp.key("Escape", "Escape", 27);
    await delay(300);

    // WF-04: folder move through the tree node menu
    await cdp.evaluate(`(()=>{const li=document.querySelector('li[data-folder-id="${childId}"]');li?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:400}));return Boolean(li);})()`);
    await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`);
    const treeMove = await cdp.evaluate(`(()=>[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent?.trim()==='移动到…'))()`);
    check("WF-04 tree node menu offers 移动到…", treeMove === true, String(treeMove));
    await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='移动到…');item?.click();return Boolean(item);})()`);
    const folderPicker = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 8000);
    check("WF-04 folder picker opens", folderPicker === true, String(folderPicker));
    await picker(`const li=d.querySelector('li[data-folder-id="${childId}"]');li?.querySelector('.folder-picker-name')?.click();return true;`);
    await delay(300);
    const selfReason = await picker(`return d.textContent||'';`);
    check("WF-02 self target disabled with a reason", selfReason.includes("自身"), String(selfReason).slice(0, 100));
    await picker(`const li=d.querySelector('li[data-folder-id="${otherId}"]');li?.querySelector('.folder-picker-name')?.click();return Boolean(li);`);
    await delay(300);
    await picker(`[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认移动')?.click();return true;`);
    const folderMoved = await cdp.waitFor(`()=>![...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 20000);
    check("WF-04 folder move commits and closes", folderMoved === true, String(folderMoved));
    const treeAfter = await call("GET", "/api/folders/tree");
    const movedFolder = (treeAfter.body?.data ?? []).find((f) => f.id === childId);
    check("WF-04 folder reparented server-side", movedFolder?.parentId === otherId, JSON.stringify(movedFolder));
    const grand = (treeAfter.body?.data ?? []).find((f) => f.name === `MV-GRAND-${stamp}`);
    check("WF-04 subtree intact", grand?.parentId === childId, JSON.stringify(grand));
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
  }

  const treeAfter = await call("GET", "/api/folders/tree");
  for (const f of treeAfter.body?.data ?? []) {
    if (String(f.name).includes("MV-") && String(f.name).includes(stamp)) {
      await call("DELETE", `/api/folders/${f.id}`);
    }
  }
  const trash = await call("GET", "/api/trash");
  for (const entry of trash.body?.data ?? []) {
    const name = String(entry.name ?? entry.oldName ?? "");
    if ((name.includes("MV-") && name.includes(stamp)) || name.startsWith("mv-")) {
      await call("DELETE", "/api/trash/" + entry.id);
    }
  }
}

// ================= G4UI suite (WF-21..23, WF-29, ACL-01..05 through the UI) =================
async function g4UiSuite() {
  const stamp = String(Date.now());
  const tree = await call("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const folderId = (await call("POST", "/api/folders", { name: `G4-${stamp}`, parentId: root.id })).body?.data?.id;
  const form = new FormData();
  form.set("folderId", folderId);
  form.set("file", new Blob([`g4 ${stamp}\n`]), `g4-${stamp}.txt`);
  form.set("idempotencyKey", "g4-" + stamp);
  const uploaded = (await (await fetch(`${BASE}/api/files`, { method: "POST", headers: { Origin: ORIGIN, Cookie: sessionCookie }, body: form })).json()).data;
  let chrome = null;
  let cdp = null;
  chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${isolatedChromeProfile()}`, "--no-sandbox",
    "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.navigate(`${BASE}/login`);
    await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`,20000);
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
    await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`);

    // ---- WF-23: favorite toggle from the file row ----
    await cdp.navigate(`${BASE}/doc?folder=${folderId}`);
    const rowReady = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr[data-id]')].some(r=>r.textContent?.includes('g4-${stamp}.txt'))`, 20000);
    check("fixture file listed", Boolean(rowReady), String(rowReady));
    const favButton = () => cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('g4-${stamp}.txt'));const b=row?[...row.querySelectorAll('.row-actions button')].find(x=>['关注','已关注','收藏','已收藏'].includes(x.textContent?.trim())):null;return b?b.textContent.trim():null;})()`);
    check("WF-23 favorite action present on the file row", (await favButton()) === "收藏" || (await favButton()) === "关注", String(await favButton()));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('g4-${stamp}.txt'));[...row.querySelectorAll('.row-actions button')].find(x=>['关注','收藏'].includes(x.textContent?.trim()))?.click();return true;})()`);
    const favorited = await cdp.waitFor(`()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('g4-${stamp}.txt'));const b=row?[...row.querySelectorAll('.row-actions button')].find(x=>['已关注','已收藏'].includes(x.textContent?.trim())):null;return Boolean(b);}`, 15000);
    check("WF-23 toggle reflects the server state", favorited === true, String(favorited));
    const favList = await call("GET", "/api/favorites");
    check("WF-23 favorite recorded server-side",
      (favList.body?.data ?? []).some((f) => f.resourceName === `g4-${stamp}.txt`), JSON.stringify((favList.body?.data ?? []).map((f) => f.resourceName)));

    // ---- WF-21: share wizard through the collaboration panel ----
    await cdp.navigate(`${BASE}/workspace`);
    const panelReady = await cdp.waitFor(`()=>document.body.textContent?.includes('创建分享')`, 20000);
    check("collaboration panel offers 创建分享", Boolean(panelReady), String(panelReady));
    const favoriteStatusBadge = await cdp.waitFor(`()=>{
      const row=[...document.querySelectorAll('.collab-results tbody tr')].find(r=>r.textContent?.includes(${JSON.stringify(`g4-${stamp}.txt`)}));
      const badge=row?.querySelector('.rare-badge[data-rare-badge-tone=success]');
      return badge?.textContent?.trim()==='正常';
    }`,10000);
    check("favorite status uses semantic RareBadge with text and success tone",favoriteStatusBadge===true,String(favoriteStatusBadge));
    // User-facing default and geometry: the primary list must not sit below
    // a full-width creator or a centered directory picker on desktop.
    const collaborationLayout = await cdp.evaluate(`(()=>{
      const tabs=document.querySelector('.collab-tablist');
      const first=tabs?.querySelector('[role=tab]');
      const left=document.querySelector('.collab-workspace .share-workbench');
      const right=document.querySelector('.collab-workspace .collab-results');
      if(!left||!right)return {ready:false};
      const a=left.getBoundingClientRect(),b=right.getBoundingClientRect();
      return {ready:true,first:first?.textContent?.trim(),selected:first?.getAttribute('aria-selected'),
        left:a.left,right:b.left,sameRow:Math.abs(a.top-b.top)<3,
        mainVisible:b.top<innerHeight-70,
        viewportOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
    })()`);
    check("collaboration defaults to 关注 with left resource picker and right results",
      collaborationLayout.ready&&collaborationLayout.first==="关注"
      &&collaborationLayout.selected==="true"&&collaborationLayout.sameRow
      &&collaborationLayout.right>collaborationLayout.left
      &&collaborationLayout.mainVisible&&collaborationLayout.viewportOverflow<=1,
      JSON.stringify(collaborationLayout));
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='创建分享')?.click();return true;})()`);
    // the panel switches to its inline workbench: filter the visible tree, pick the fixture folder
    const benchReady = await cdp.waitFor(`()=>document.querySelector('#share-picker-filter')!==null`, 10000);
    check("WF-21 resource workbench opens", benchReady === true, String(benchReady));
    await cdp.evaluate(`(()=>{
      const search=document.querySelector('#share-picker-filter');
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(search,${JSON.stringify(`G4-${stamp}`)});
      search.dispatchEvent(new Event('input',{bubbles:true}));
      return true;})()`);
    await delay(500);
    const folderPicked = await cdp.evaluate(`(()=>{
      const btn=[...document.querySelectorAll('.share-picker-row')].find(b=>b.textContent?.includes(${JSON.stringify(`G4-${stamp}`)}));
      btn?.click();return Boolean(btn);})()`);
    await delay(300);
    const chosenRaw = await cdp.evaluate(`(()=>document.querySelector('.share-chosen')?.textContent||'')()`);
    console.log("DEBUG chosenRaw:", typeof chosenRaw, JSON.stringify(chosenRaw));
    const chosenShown = typeof chosenRaw === "string" ? chosenRaw : String(chosenRaw ?? "");
    check("WF-21 chosen resource shown with its name", folderPicked === true && chosenShown.includes(`G4-${stamp}`), String(chosenShown));
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='分享…')?.click();return true;})()`);
    // the share dialog: recipient kind + real recipient list + actions + submit
    const shareDialog = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('分享'));return d?d.textContent.slice(0,80):false;}`, 10000);
    check("WF-21 share dialog opens with the chosen resource", Boolean(shareDialog), String(shareDialog));
    const recipientsReady = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('创建分享'));return d&&d.querySelectorAll('.share-recipient-list [role=radio]').length>=1?true:false;}`, 15000);
    check("WF-21 recipient list loaded from the real endpoint", recipientsReady === true, String(recipientsReady));
    const recipientState = await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('创建分享'));
      if(!d)return {dialog:false};
      const radios=[...d.querySelectorAll('.share-recipient-list [role=radio]')];
      const checked=[...d.querySelectorAll('input[type=checkbox]')].filter(c=>c.checked).length;
      return {dialog:true,recipients:radios.length,first:radios[0]?radios[0].textContent?.trim():'',checkedActions:checked};})()`);
    check("WF-21 recipient picker lists real users with default actions",
      recipientState.dialog === true && recipientState.recipients >= 1 && recipientState.checkedActions >= 1,
      JSON.stringify(recipientState));
    await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('创建分享'));
      const radio=d.querySelector('.share-recipient-list [role=radio]');
      radio?.click();return Boolean(radio);})()`);
    await delay(300);
    await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('创建分享'));
      const btn=[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='创建分享');
      btn?.click();return Boolean(btn);})()`);
    const shareClosed = await cdp.waitFor(`()=>![...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.textContent?.includes('创建分享'))`, 20000);
    check("WF-21 share dialog closes after commit", shareClosed === true, String(shareClosed));
    const shares = await call("GET", "/api/shares?scope=sent");
    const created = (shares.body?.data ?? []).find((s) => s.resourceName === `G4-${stamp}`);
    check("WF-21 share recorded server-side with the chosen resource and recipient",
      Boolean(created) && created.actions.length >= 1 && Boolean(created.recipientId),
      JSON.stringify(created ?? null));

    // ---- WF-29: stats scope through the picker ----
    await cdp.navigate(`${BASE}/stats`);
    const statsReady = await cdp.waitFor(`()=>document.body.textContent?.includes('选择目录')`, 20000);
    check("WF-29 stats page offers the directory picker", Boolean(statsReady), String(statsReady));
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='选择目录')?.click();return true;})()`);
    const statsPicker = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 8000);
    check("WF-29 folder picker opens", statsPicker === true, String(statsPicker));
    await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      const search=d.querySelector('.folder-picker-search');
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(search,${JSON.stringify(`G4-${stamp}`)});
      search.dispatchEvent(new Event('input',{bubbles:true}));
      return true;})()`);
    await delay(500);
    await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      const btn=[...d.querySelectorAll('.folder-picker-result')].find(b=>b.textContent?.includes(${JSON.stringify(`G4-${stamp}`)}));
      btn?.click();return Boolean(btn);})()`);
    await delay(300);
    await cdp.evaluate(`(()=>{
      const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      [...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='应用')?.click();return true;})()`);
    const applied = await cdp.waitFor(`()=>{const link=document.querySelector('a.stats-export[href*="exports/files.csv"]');return link&&link.href.includes('folder=')?link.href:false;}`, 15000);
    check("WF-29 export link carries the chosen folder", typeof applied === "string" && new URL(applied).searchParams.get("folder") === folderId, String(applied));
    const manualInput = await cdp.evaluate(`(()=>[...document.querySelectorAll('input')].some(i=>i.placeholder==='folder_…'))()`);
    console.log("DEBUG manualInput:", typeof manualInput, JSON.stringify(manualInput));
    check("WF-29 manual folder-ID input is gone", manualInput === false, String(manualInput));

    // ---- ACL-01..05: V3 organization PermissionsPanel is inline, not a modal ----
    // The real URL carries the selected folder. This avoids a brittle
    // context-menu implementation detail while exercising the same ACL editor.
    await cdp.navigate(`${BASE}/org?tab=permissions&folder=${encodeURIComponent(folderId)}`);
    const grantOpen = await cdp.waitFor(`()=>{
      const panel=document.querySelector('#org-panel-permissions');
      return Boolean(panel?.querySelector('.perm-form select')&&panel.textContent?.includes('新增直接授权'));
    }`,15000);
    check("ACL permission workbench opens for the selected folder",
      grantOpen===true,String(grantOpen));
    const kindOptions = await cdp.evaluate(`(()=>{
      const form=document.querySelector('#org-panel-permissions .perm-form');
      const selects=[...form.querySelectorAll('select')];
      return {kinds:selects.length?[...selects[0].options].map(o=>o.value):[],
        subjects:selects.length>1?[...selects[1].options].map(o=>o.textContent?.trim()).slice(0,4):[],
        selectedFolder:document.querySelector('.perm-detail-heading .perm-path')?.textContent?.trim()};
    })()`);
    check("ACL subject kinds are user/group",
      JSON.stringify(kindOptions.kinds)===JSON.stringify(["group","user"]) &&
      kindOptions.selectedFolder.length>0,JSON.stringify(kindOptions));

    const userSource = await cdp.evaluate(`(()=>{
      const selects=[...document.querySelectorAll('.perm-form select')];
      const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
      set.call(selects[0],'user');selects[0].dispatchEvent(new Event('change',{bubbles:true}));
      return true;})()`);
    await delay(450);
    const userOptions = await cdp.evaluate(`(()=>[...document.querySelectorAll('.perm-form select')[1].options].map(o=>o.textContent?.trim()))()`);
    check("ACL-01 user kind lists real user accounts",
      userSource===true && userOptions.length>=2 && userOptions.some(o=>o&&!o.includes("请选择")),JSON.stringify(userOptions.slice(0,6)));

    await cdp.evaluate(`(()=>{
      const selects=[...document.querySelectorAll('.perm-form select')];
      const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
      set.call(selects[0],'group');selects[0].dispatchEvent(new Event('change',{bubbles:true}));
      return true;})()`);
    await delay(450);
    const groupOptions = await cdp.evaluate(`(()=>[...document.querySelectorAll('.perm-form select')[1].options].map(o=>o.textContent?.trim()))()`);
    check("ACL-01 group kind lists real workgroups",
      Array.isArray(groupOptions) && groupOptions.length>=2 &&
      groupOptions.some(o=>o&&o!=="请选择"&&!o.startsWith("grp_")),
      JSON.stringify(groupOptions));
    const expiryPresent = await cdp.evaluate(`(()=>Boolean(document.querySelector(
      '#org-panel-permissions .perm-form input[type="datetime-local"]')))()`);
    check("ACL-05 expiry control present",expiryPresent===true,String(expiryPresent));
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
    // Crash-safe cleanup: a mid-suite failure must not leak fixtures.
    const shares = await call("GET", "/api/shares?scope=sent");
    for (const s of shares.body?.data ?? []) {
      if (s.resourceName === `G4-${stamp}`) await call("DELETE", `/api/shares/${s.id}`);
    }
    if (uploaded?.fileId) await call("DELETE", `/api/favorites/file/${uploaded.fileId}`);
    if (folderId) await call("DELETE", `/api/folders/${folderId}`);
    const trash = await call("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name === `G4-${stamp}` || name.startsWith(`g4-${stamp}`)) {
        await call("DELETE", "/api/trash/" + entry.id);
      }
    }
  }
}

// ================= BATCHUI suite (WF-07/08 batch move UI, purge, upload phases) =================
async function batchUiSuite() {
  const stamp = String(Date.now());
  let chrome = null;
  let cdp = null;
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: sessionCookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const mk = async (name) => (await json("POST", "/api/folders", { name, parentId: root.id })).body?.data?.id;
  const aId = await mk(`BM-A-${stamp}`);
  const bId = await mk(`BM-B-${stamp}`);
  const cId = await mk(`BM-C-${stamp}`);
  const upload = async (folder, name) => {
    const form = new FormData();
    form.set("folderId", folder);
    form.set("file", new Blob([`bm ${name} ${stamp}\n`]), name);
    form.set("idempotencyKey", `${folder}-${name}-${stamp}`);
    return (await (await fetch(`${BASE}/api/files`, { method: "POST", headers: { Origin: BASE, Cookie: sessionCookie }, body: form })).json()).data;
  };
  const f1 = await upload(aId, "bm-1.txt");
  const f2 = await upload(aId, "bm-2.txt");
  await upload(aId, "bm-3.txt");
  await upload(bId, "bm-dup.txt");
  const dup = await upload(aId, "bm-dup.txt");
  const listIn = async (folder) => ((await json("GET", `/api/files?folder=${folder}&limit=200`)).body?.data?.items ?? []).map((f) => f.name);

  // ---- WF-07: batch commit through the API ----
  let r = await json("POST", "/api/files/move-batch", { fileIds: [f1.fileId, f2.fileId], targetFolderId: cId, mode: "all_or_nothing", idempotencyKey: "bm-key-1" });
  const committed = r.body?.data ?? {};
  check("WF-07 batch commits", r.status === 200 && committed.status === "committed" && committed.count === 2 && (committed.moved ?? []).length === 2, JSON.stringify(committed).slice(0, 160));
  let inC = await listIn(cId);
  check("WF-07 both files in the target", inC.includes("bm-1.txt") && inC.includes("bm-2.txt"), JSON.stringify(inC));
  check("WF-07 source list emptied of them", !(await listIn(aId)).includes("bm-1.txt"), "");

  // ---- WF-08: replay returns the same result ----
  r = await json("POST", "/api/files/move-batch", { fileIds: [f1.fileId, f2.fileId], targetFolderId: cId, mode: "all_or_nothing", idempotencyKey: "bm-key-1" });
  check("WF-08 replay returns the same committed result", r.status === 200 && r.body?.data?.status === "committed" && r.body?.data?.count === 2, JSON.stringify(r.body?.data ?? {}).slice(0, 120));

  // ---- all-or-nothing: the duplicate name conflicts the whole batch ----
  r = await json("POST", "/api/files/move-batch", { fileIds: [dup.fileId, f1.fileId], targetFolderId: bId, mode: "all_or_nothing", idempotencyKey: "bm-key-2" });
  const conflicted = r.body?.data ?? {};
  check("all-or-nothing conflict with a per-item entry",
    r.status === 200 && conflicted.status === "conflict" && (conflicted.conflicts ?? []).some((c) => c.id === dup.fileId && c.code === "E_NAME_CONFLICT"),
    JSON.stringify(conflicted).slice(0, 200));
  const inC2 = await listIn(cId);
  check("conflict wrote nothing (f1 still in C)", inC2.includes("bm-1.txt"), JSON.stringify(inC2));
  check("conflict left the duplicate in A", (await listIn(aId)).includes("bm-dup.txt"), "");

  // ---- over-limit ----
  const over = Array.from({ length: 101 }, (_, i) => "file_" + i);
  r = await json("POST", "/api/files/move-batch", { fileIds: over, targetFolderId: bId, mode: "all_or_nothing", idempotencyKey: "bm-key-3" });
  check("over-limit batch rejected with the limit in the message",
    r.status === 400 && r.body?.error?.code === "E_BAD" && /100/.test(r.body?.error?.message ?? ""), JSON.stringify(r.body).slice(0, 160));

  chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${isolatedChromeProfile()}`, "--no-sandbox",
    "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.navigate(`${BASE}/login`);
    await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`,20000);
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
    await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`);

    // ---- UI: multi-selection batch move through the picker ----
    await cdp.navigate(`${BASE}/doc?folder=${cId}`);
    const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=2`, 20000);
    check("target folder rows listed", Boolean(rowsReady), String(rowsReady));
    await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[0]?.click();rows[1]?.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()`);
    const selCount = await cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].filter(r=>r.getAttribute('aria-selected')==='true').length)()`);
    check("two rows selected for the batch", selCount === 2, String(selCount));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')][0];row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return true;})()`);
    await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`);
    const batchMenu = await cdp.evaluate(`(()=>{const items=[...document.querySelectorAll('[role=menuitem]')].map(b=>b.textContent?.trim());return {hasMove:items.includes('移动到…'),items};})()`);
    check("WF-11 multi-selection menu offers the set-wide move only",
      batchMenu.hasMove === true && batchMenu.items.some((i) => i.startsWith("删除")) && !batchMenu.items.some((i) => i.startsWith("编辑")),
      JSON.stringify(batchMenu.items));
    await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='移动到…');item?.click();return Boolean(item);})()`);
    const batchDialog = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));return d&&/移动 2 个文件/.test(d.textContent||'')?true:false;}`, 10000);
    check("WF-07 batch picker opens scoped to the selection", batchDialog === true, String(batchDialog));
    const pick = (name) => cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      const input=d.querySelector('.folder-picker-search');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await pick(`BM-A-${stamp}`);
    await delay(500);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      const btn=[...d.querySelectorAll('.folder-picker-result')].find(b=>b.textContent?.includes(${JSON.stringify(`BM-A-${stamp}`)}));btn?.click();return Boolean(btn);})()`);
    await delay(300);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      [...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认移动')?.click();return true;})()`);
    const batchClosed = await cdp.waitFor(`()=>![...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 20000);
    check("WF-07 batch move commits through the UI", batchClosed === true, String(batchClosed));
    const inAAfter = await listIn(aId);
    check("WF-07 both files landed back in A", inAAfter.includes("bm-1.txt") && inAAfter.includes("bm-2.txt"), JSON.stringify(inAAfter));

    // ---- UI: conflict list + exclude-and-retry (continue in A, which still holds files) ----
    await cdp.navigate(`${BASE}/doc?folder=${aId}`);
    await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
    await cdp.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('tbody tr[data-id]')];
      const dupRow=rows.find(r=>r.textContent?.includes('bm-dup.txt'));
      const other=rows.find(r=>r.textContent?.includes('bm-1.txt'));
      if(!dupRow||!other)return false;
      other.click();
      dupRow.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));
      return true;})()`);
    const conflictSel = await cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].filter(r=>r.getAttribute('aria-selected')==='true').length)()`);
    check("conflict scenario selects the duplicate plus one clean file", conflictSel === 2, String(conflictSel));
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.getAttribute('aria-selected')==='true');row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return true;})()`);
    await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`);
    await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='移动到…');item?.click();return Boolean(item);})()`);
    await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 8000);
    await pick(`BM-B-${stamp}`);
    await delay(500);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      const btn=[...d.querySelectorAll('.folder-picker-result')].find(b=>b.textContent?.includes(${JSON.stringify(`BM-B-${stamp}`)}));btn?.click();return Boolean(btn);})()`);
    await delay(300);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));
      [...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认移动')?.click();return true;})()`);
    const conflictShown = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));return d&&/同名|无法移动/.test(d.textContent||'')?d.textContent.slice(0,80):false;}`, 15000);
    check("WF-07 UI conflict keeps the dialog open with the reason", Boolean(conflictShown), String(conflictShown));
    const excludeBtn = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));const b=d?[...d.querySelectorAll('button')].find(x=>/排除/.test(x.textContent||'')):null;return b?{label:b.textContent?.trim(),disabled:b.disabled}:null;})()`);
    check("exclude-and-retry offered after a conflict", Boolean(excludeBtn) && excludeBtn.disabled === false, JSON.stringify(excludeBtn));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));[...d.querySelectorAll('button')].find(x=>/排除/.test(x.textContent||''))?.click();return true;})()`);
    await delay(400);
    const remainder = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));return d?d.textContent?.match(/剩余 (\d+) 个/)?.[1]??d.textContent?.slice(0,60):null;})()`);
    check("exclude narrows the batch to the clean remainder", remainder !== null, String(remainder));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认移动')?.click();return true;})()`);
    const retryClosed = await cdp.waitFor(`()=>![...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.querySelector('.folder-picker'))`, 20000);
    check("WF-07 remainder commits after exclusion", retryClosed === true, String(retryClosed));
    const inBAfter = await listIn(bId);
    // B legitimately holds its own bm-dup.txt from the fixture; the excluded copy must stay in A.
    check("excluded file stayed, clean file moved",
      inBAfter.includes("bm-1.txt") && (await listIn(aId)).includes("bm-dup.txt"),
      JSON.stringify({ inB: inBAfter, inA: await listIn(aId) }));
    await cdp.key("Escape", "Escape", 27);
    await delay(300);

    // ---- purge: admin-gated, two-stage confirmation ----
    const victim = await upload(aId, "bm-purge.txt");
    await json("DELETE", `/api/files/${victim.fileId}`);
    await cdp.navigate(`${BASE}/trash`);
    const purgeBtn = await cdp.waitFor(`()=>{const row=[...document.querySelectorAll('.trash-table tbody tr')].find(tr=>tr.textContent?.includes('bm-purge.txt'));return Boolean(row?.querySelector('button[aria-label^="更多操作"]'));}`, 20000);
    check("purge entry visible for admin", purgeBtn === true, String(purgeBtn));
    const purgeMenuOpened=await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.trash-table tbody tr')].find(tr=>tr.textContent?.includes('bm-purge.txt'));const b=row?.querySelector('button[aria-label^="更多操作"]');b?.click();return Boolean(b);})()`);
    if(!purgeMenuOpened)throw Error("admin purge action missing from trash row");
    const purgeMenu=await cdp.waitFor(`()=>!![...document.querySelectorAll('[role="menu"][aria-label="回收站操作"] [role="menuitem"]')].find(b=>b.textContent?.trim()==='永久删除')`,8000);
    check("admin purge lives in the row action menu",purgeMenu===true,String(purgeMenu));
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('[role="menu"][aria-label="回收站操作"] [role="menuitem"]')].find(b=>b.textContent?.trim()==='永久删除')?.click();return true;})()`);
    const stage1 = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog[open]')].find(x=>x.textContent?.includes('永久删除'));return d?d.textContent.slice(0,150):false;}`, 8000);
    check("purge stage 1 states the irreversible impact", typeof stage1 === "string" && stage1.includes("无法撤销")&&stage1.includes("bm-purge.txt"), String(stage1));
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog[open]')].find(x=>x.textContent?.includes('永久删除'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='继续')?.click();return true;})()`);
    const stage2 = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog[open]')].find(x=>x.textContent?.includes('再次确认'));return d?true:false;}`, 8000);
    check("purge requires the second confirmation", stage2 === true, String(stage2));
    // Same hold-to-confirm gesture as WF-13 (spec 6.3): press, hold past the fill, no click.
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog[open]')].find(x=>x.textContent?.includes('再次确认'));const b=[...d.querySelectorAll('button')].find(x=>x.textContent?.trim()==='确认永久删除');b?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));return Boolean(b);})()`);
    await delay(1200);
    const purged = await cdp.waitFor(`()=>![...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('bm-purge.txt'))`, 20000);
    check("purge removes the entry from the trash", purged === true, String(purged));

    // ---- upload two-phase progress ----
    await cdp.navigate(`${BASE}/doc?folder=${aId}`);
    await cdp.waitFor(`()=>document.querySelector('.dropzone')!==null`, 20000);
    const phases = await cdp.evaluate(`(async ()=>{
      const seen={progress:false,processing:false};
      const zone=document.querySelector('.dropzone');
      const dt=new DataTransfer();
      dt.items.add(new File([new Uint8Array(3*1024*1024)],'bm-big.bin',{type:'application/octet-stream'}));
      zone.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        const item=[...document.querySelectorAll('.upload-item')].find(li=>li.textContent?.includes('bm-big.bin'));
        if(item){
          if(item.querySelector('.upload-progress'))seen.progress=true;
          if(/服务端处理中/.test(item.textContent||''))seen.processing=true;
          if(item.className.includes('committed'))break;
        }
        await new Promise(r=>setTimeout(r,30));
      }
      return seen;})()`);
    check("upload shows the byte-progress phase", phases && phases.progress === true, JSON.stringify(phases));
    const bigCommitted = await cdp.waitFor(`()=>{const item=[...document.querySelectorAll('.upload-item')].find(li=>li.textContent?.includes('bm-big.bin'));return item&&item.className.includes('committed')?true:false;}`, 30000);
    check("upload commits after the server phase", bigCommitted === true, String(bigCommitted));
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
    // Crash-safe cleanup: a mid-suite failure must not leak fixtures.
    for (const folder of [aId, bId, cId]) {
      if (folder) await json("DELETE", `/api/folders/${folder}`);
    }
    const trash = await json("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name.startsWith("bm-") || (name.startsWith("BM-") && name.includes(stamp))) {
        await json("DELETE", "/api/trash/" + entry.id);
      }
    }
  }
}

// ================= FINALE suite (WF-30 paging, WF-32 org, DI-17 drag-move, WF-21 recipients) =================
async function finaleSuite() {
  const stamp = String(Date.now());
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: sessionCookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let chrome = null;
  let cdp = null;
  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const mk = async (name) => (await json("POST", "/api/folders", { name, parentId: root.id })).body?.data?.id;
  const folderId = await mk(`WF-SMOKE-${stamp}`);

  // ---- fixture: 60 files sharing a search token ----
  const TOKEN = `zzq${stamp}`;
  for (let i = 0; i < 60; i++) {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([`${TOKEN} body ${i}\n`]), `${TOKEN}-${String(i).padStart(3, "0")}.txt`);
    form.set("idempotencyKey", `${TOKEN}-${i}-${stamp}`);
    await fetch(`${BASE}/api/files`, { method: "POST", headers: { Origin: BASE, Cookie: sessionCookie }, body: form });
  }
  // a second folder with one file for the drag target
  const targetId = await mk(`WF-TARGET-${stamp}`);
  const tform = new FormData();
  tform.set("folderId", targetId);
  tform.set("file", new Blob([`target ${stamp}\n`]), "wf-target.txt");
  tform.set("idempotencyKey", "wf-target-" + stamp);
  await fetch(`${BASE}/api/files`, { method: "POST", headers: { Origin: BASE, Cookie: sessionCookie }, body: tform });

  // ---- API: search cursor ----
  let r = await json("GET", `/api/search?q=${TOKEN}&limit=50`);
  let page = r.body?.data ?? {};
  check("WF-30 first page returns 50 with a cursor",
    r.status === 200 && (page.items ?? []).length === 50 && typeof page.nextCursor === "string" && page.nextCursor.length > 0,
    JSON.stringify({ n: (page.items ?? []).length, total: page.total, cursor: String(page.nextCursor).slice(0, 10) }));
  r = await json("GET", `/api/search?q=${TOKEN}&limit=50&cursor=${encodeURIComponent(page.nextCursor)}`);
  const page2 = r.body?.data ?? {};
  const ids1 = new Set((page.items ?? []).map((f) => f.id));
  const dup = (page2.items ?? []).filter((f) => ids1.has(f.id)).length;
  check("WF-30 second page appends without duplicates",
    r.status === 200 && (page2.items ?? []).length === 10 && dup === 0 && page2.nextCursor === "",
    JSON.stringify({ n: (page2.items ?? []).length, dup, cursor: page2.nextCursor }));
  const all = [...(page.items ?? []), ...(page2.items ?? [])];
  check("WF-30 every match returned exactly once", all.length === 60 && new Set(all.map((f) => f.id)).size === 60, String(all.length));
  r = await json("GET", `/api/search?q=${TOKEN}&limit=50&cursor=!!!forged!!!`);
  check("WF-30 a forged cursor restarts at page 1",
    r.status === 200 && (r.body?.data?.items ?? []).length === 50, String((r.body?.data?.items ?? []).length));

  // ---- API: share recipients for a non-admin ----
  const probeLogin = `wfprobe${stamp}`;
  const probePw = "Wf-Probe-Pw-9f2c71ad40b6";
  const created = await json("POST", "/api/users", { login: probeLogin, displayName: "工作流探针", password: probePw });
  check("probe user created", created.status === 200 || created.status === 201, JSON.stringify(created.body));
  const probeLoginRes = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ login: probeLogin, password: probePw }),
  });
  const probeCookie = probeLoginRes.headers.getSetCookie().find((c) => c.startsWith("fm_session=")).split(";")[0];
  const pwChange = await fetch(`${BASE}/api/me/password`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, Cookie: probeCookie },
    body: JSON.stringify({ oldPassword: probePw, newPassword: "Wf-Probe-Pw2-9f2c71ad40b6" }),
  });
  check("probe completed the first-login password change", pwChange.status === 200, String(pwChange.status));
  const probeCall = async (method, path) => {
    const res = await fetch(BASE + path, { method, headers: { Origin: BASE, Cookie: probeCookie } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  r = await probeCall("GET", "/api/share-recipients?kind=user&limit=5");
  const recips = r.body?.data ?? {};
  check("WF-21 non-admin can list share recipients",
    r.status === 200 && Array.isArray(recips.items) && recips.items.length >= 1
    && recips.items.every((u) => Object.keys(u).sort().join(",") === "displayName,id"),
    JSON.stringify(recips.items?.slice(0, 2)));
  r = await probeCall("GET", "/api/share-recipients?kind=group&limit=5");
  check("WF-21 group recipients carry only id+name",
    r.status === 200 && (r.body?.data?.items ?? []).every((g) => Object.keys(g).sort().join(",") === "id,name"),
    JSON.stringify((r.body?.data?.items ?? []).slice(0, 2)));
  r = await probeCall("GET", "/api/share-recipients?kind=dept");
  check("WF-21 an invalid recipient kind is rejected", r.status === 400 && r.body?.error?.code === "E_BAD", JSON.stringify(r.body));

  chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${isolatedChromeProfile()}`, "--no-sandbox",
    "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    const loginUi = async (user, pw) => {
      await cdp.navigate(`${BASE}/login`);
      await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`,20000);
      await cdp.evaluate(`(()=>{
        const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
        const fields=[...document.querySelectorAll('input')];
        const u=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
        const p=document.querySelector('input[type=password]');
        if(u)set(u,${JSON.stringify(user)});
        if(p)set(p,${JSON.stringify(pw)});
        [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
      return cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 20000);
    };
    const finaleAuthenticated=await loginUi("admin", password);
    const finaleLoginState=await cdp.evaluate(`(()=>({path:location.pathname,login:!!document.querySelector('input[type=password]')}))()`);
    check("finale admin session navigated to workspace",finaleAuthenticated===true&&finaleLoginState.path==="/doc",JSON.stringify(finaleLoginState));
    if(!finaleAuthenticated||finaleLoginState.path!=="/doc")throw Error("finale browser has no authenticated workspace session");

    // ---- UI: search 加载更多 ----
    await cdp.navigate(`${BASE}/search`);
    const searchReady = await cdp.waitFor(`()=>document.querySelector('#search-q')!==null`, 20000);
    const searchPageState=await cdp.evaluate(`(()=>({path:location.pathname,title:document.title,login:!!document.querySelector('input[type=password]'),error:document.querySelector('[role=alert]')?.textContent?.slice(0,120)||''}))()`);
    check("search page ready", Boolean(searchReady), JSON.stringify(searchPageState));
    if(!searchReady)throw Error("search page not ready after navigation: "+JSON.stringify(searchPageState));
    await cdp.evaluate(`(()=>{
      const q=document.querySelector('#search-q');
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(q,${JSON.stringify(TOKEN)});
      q.dispatchEvent(new Event('input',{bubbles:true}));
      const btn=document.querySelector('.search-primary button[type="submit"]');
      btn?.click();return Boolean(btn);})()`);
    const firstRows = await cdp.waitFor(`()=>document.querySelectorAll('.search-data-table tbody tr').length>=50`, 30000);
    check("WF-30 search renders the first page", firstRows === true, String(await cdp.evaluate(`(()=>document.querySelectorAll('.search-data-table tbody tr').length)()`)));
    const moreVisible = await cdp.waitFor(`()=>!!document.querySelector('.search-more button:not([disabled])')`, 15000);
    check("WF-30 加载更多 appears with a cursor", moreVisible === true, String(moreVisible));
    await cdp.evaluate(`(()=>{document.querySelector('.search-more button')?.click();return true;})()`);
    const allRows = await cdp.waitFor(`()=>document.querySelectorAll('.search-data-table tbody tr').length>=60`, 30000);
    const uniqueRows = await cdp.evaluate(`(()=>{const names=[...document.querySelectorAll('.search-data-table tbody tr')].map(tr=>tr.querySelector('td a')?.textContent?.trim());return {rows:names.length,unique:new Set(names).size};})()`);
    check("WF-30 加载更多 appends the rest without duplicates",
      allRows === true && uniqueRows.rows === 60 && uniqueRows.unique === 60, JSON.stringify(uniqueRows));
    const countLine = await cdp.evaluate(`(()=>document.querySelector('.search-total')?.textContent||'')()`);
    check("WF-30 the count line reflects the loaded pages", /已显示 60/.test(countLine), String(countLine));

    // ---- G2: file explorer cursor paging is not the search paging path ----
    await cdp.navigate(`${BASE}/doc?folder=${folderId}`);
    const firstFilePage = await cdp.waitFor(`()=>document.querySelectorAll('.file-table tbody tr[data-id]').length===50&&!!document.querySelector('.file-page-controls button')`,30000);
    check("G2 explorer first page contains 50 files and a paging control",firstFilePage===true,String(firstFilePage));
    const requestedMore = await cdp.evaluate(`(()=>{const button=document.querySelector('.file-page-controls button');if(!button||button.disabled)return false;button.click();button.click();return true;})()`);
    check("G2 explorer load more accepts rapid clicks safely",requestedMore===true,String(requestedMore));
    const allFiles = await cdp.waitFor(`()=>document.querySelectorAll('.file-table tbody tr[data-id]').length===60`,30000);
    const filePage = await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('.file-table tbody tr[data-id]')],ids=rows.map(r=>r.getAttribute('data-id'));return {count:rows.length,unique:new Set(ids).size,hasMore:!!document.querySelector('.file-page-controls button'),summary:document.querySelector('.status-left')?.textContent};})()`);
    check("G2 explorer appends exactly 10 distinct files and marks the page complete",
     allFiles===true&&filePage.count===60&&filePage.unique===60&&!filePage.hasMore&&filePage.summary?.includes("共 60 个文件"),JSON.stringify(filePage));

    // ---- UI: org workbench (WF-32) ----
    await cdp.navigate(`${BASE}/org`);
    const orgReady = await cdp.waitFor(`()=>document.querySelector('ul[role=tree]')!==null||document.querySelector('input[aria-label="新账号"]')!==null`, 20000);
    check("WF-32 org page renders the workbench", Boolean(orgReady), String(orgReady));
    const resetEntry = await cdp.evaluate(`(()=>{const btns=[...document.querySelectorAll('button')].map(b=>b.textContent?.trim());return {reset:btns.includes('重置密码'),disable:btns.includes('禁用')};})()`);
    check("WF-32 member actions available without window.prompt", resetEntry.reset === true && resetEntry.disable === true, JSON.stringify(resetEntry));
    // open the reset-password dialog (the first row's action)
    await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.querySelector('button'));const btn=row?[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='重置密码'):null;btn?.click();return Boolean(btn);})()`);
    const resetDialog = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('重置'));return d?d.textContent.slice(0,60):false;}`, 10000);
    check("WF-32 password reset is a real dialog", typeof resetDialog === "string", String(resetDialog));
    await cdp.key("Escape", "Escape", 27);
    await delay(300);

    // ---- UI: internal drag -> move dialog (DI-17) ----
    await cdp.navigate(`${BASE}/doc?folder=${folderId}`);
    const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=2`, 30000);
    check("drag source rows listed", Boolean(rowsReady), String(rowsReady));
    // A real gesture separates dragstart and drop in time; the synthesized one
    // must let React commit the DragSession between the two dispatches.
    const dragResult = await cdp.evaluate(`(()=>{
      const row=[...document.querySelectorAll('tbody tr[data-id]')][0];
      if(!row)return 'no-row';
      const dt=new DataTransfer();
      dt.setData('application/x-filesmanage-files',JSON.stringify({ids:[row.getAttribute('data-id')],sourceFolderId:${JSON.stringify(folderId)},focusId:row.getAttribute('data-id')}));
      dt.setData('text/plain','移动 1 个文件');
      row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
      const li=document.querySelector('li[data-folder-id="${targetId}"]');
      if(!li)return 'no-target-node';
      window.__wfdt=dt;
      return 'dragstarted';})()`);
    await delay(600);
    const dropResult = await cdp.evaluate(`(()=>{
      const dt=window.__wfdt;
      const li=document.querySelector('li[data-folder-id="${targetId}"]');
      if(!li||!dt)return 'no-target';
      const rowEl=li.querySelector('.tree-row')||li;
      rowEl.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
      rowEl.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      return 'dropped';})()`);
    const moveDialog = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));return d?{title:d.querySelector('.dialog-title')?.textContent,target:d.querySelector('.folder-picker-candidate')?.textContent}:false;}`, 10000);
    check("DI-17 dropping on a folder opens the move dialog",
      dragResult === "dragstarted" && dropResult === "dropped" && Boolean(moveDialog), JSON.stringify({ dragResult, dropResult, moveDialog }));
    const targetPreset = moveDialog && /WF-TARGET/.test(moveDialog.target || "");
    check("DI-17 the dropped folder is the pre-selected candidate", targetPreset === true, JSON.stringify(moveDialog));
    // cancel: no server change
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.querySelector('.folder-picker'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='取消')?.click();return true;})()`);
    await delay(400);
    const stillThere = await cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].length>=2)()`);
    check("DI-17 cancelling the drop changes nothing", stillThere === true, String(stillThere));

    // ---- G2: upload is OS-file-only, with bounded queue geometry ----
    const dragPolicy=await cdp.evaluate(`(()=>{
      const zone=document.querySelector('.dropzone');
      const text=new DataTransfer();text.setData('text/plain','selected editor text');
      const textOver=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:text});
      zone.dispatchEvent(textOver);
      const fileDrop=new DataTransfer();
      for(let i=0;i<10;i++)fileDrop.items.add(new File(['G2 queue '+i],${JSON.stringify("g2-queue-"+stamp+"-")}+i+'.txt',{type:'text/plain'}));
      const fileOver=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:fileDrop});
      zone.dispatchEvent(fileOver);
      const input=zone.querySelector('input[aria-label="当前已加载文件名过滤"]');
      const inputOver=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:fileDrop});
      input?.dispatchEvent(inputOver);
      window.__g2files=fileDrop;
      return {textPrevented:textOver.defaultPrevented,filePrevented:fileOver.defaultPrevented,inputPrevented:inputOver.defaultPrevented};
    })()`);
    check("G2 upload drop accepts OS files but leaves text and inputs alone",
      !dragPolicy.textPrevented&&dragPolicy.filePrevented&&!dragPolicy.inputPrevented,JSON.stringify(dragPolicy));
    await cdp.evaluate(`(()=>{document.querySelector('.dropzone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__g2files}));return true;})()`);
    await cdp.waitFor(`()=>document.querySelectorAll('.upload-queue-list .upload-item').length>=10`,18000);
    const queueGeometry=await cdp.evaluate(`(()=>{const list=document.querySelector('.upload-queue-list'),pane=document.querySelector('.work-body>.table'),r=list.getBoundingClientRect();return {count:list.children.length,height:r.height,scrollHeight:list.scrollHeight,overflow:document.documentElement.scrollWidth-innerWidth,paneHeight:pane?.getBoundingClientRect().height,expand:document.querySelector('.upload-queue-header button[aria-controls=upload-queue-list]')?.getAttribute('aria-expanded')};})()`);
    check("G2 ten upload rows scroll inside bounded dock without squeezing the file list",
      queueGeometry.count===10&&queueGeometry.height<=225&&queueGeometry.scrollHeight>queueGeometry.height&&queueGeometry.overflow<=2&&queueGeometry.paneHeight>=110&&queueGeometry.expand==="true",JSON.stringify(queueGeometry));
    for(const width of [390,760,1366]){
      await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:840,deviceScaleFactor:1,mobile:false});
      await delay(100);
      const geometry=await cdp.evaluate(`(()=>{const list=document.querySelector('.upload-queue-list'),work=document.querySelector('.work-body>.table'),queue=document.querySelector('.upload-queue'),r=queue.getBoundingClientRect();return {width:innerWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth,queueRight:r.right,queueWidth:r.width,listHeight:list.getBoundingClientRect().height,listOverflow:list.scrollWidth-list.clientWidth,paneHeight:work.getBoundingClientRect().height,buttonVisible:document.querySelector('.upload-queue-header button[aria-controls=upload-queue-list]').getBoundingClientRect().width>0};})()`);
      check("G2 upload dock "+width+"px fits the pane and retains the file list",
        geometry.pageOverflow<=2&&geometry.queueRight<=width+2&&geometry.queueWidth>150&&geometry.listHeight<=225&&geometry.listOverflow<=2&&geometry.paneHeight>105&&geometry.buttonVisible,JSON.stringify(geometry));
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.evaluate(`(()=>{document.querySelector('.upload-queue-header button[aria-controls=upload-queue-list]').click();return true;})()`);
    check("G2 upload dock can collapse without losing tasks",
      await cdp.evaluate(`(()=>!document.querySelector('.upload-queue-list')&&document.querySelector('.upload-queue-header button[aria-controls=upload-queue-list]')?.getAttribute('aria-expanded')==='false')()`));
    await cdp.evaluate(`(()=>{document.querySelector('.upload-queue-header button[aria-controls=upload-queue-list]').click();return true;})()`);
    await cdp.evaluate(`(()=>{document.querySelector('li[data-folder-id="${targetId}"]>.tree-row').click();return true;})()`);
    await cdp.waitFor(`()=>new URLSearchParams(location.search).get('folder')===${JSON.stringify(targetId)}`,16000);
    await cdp.waitFor(`()=>document.querySelectorAll('.upload-item-target').length>=10`,16000);
    check("G2 folder switch keeps queued task destinations on their original folder",
      (await cdp.evaluate(`(()=>[...document.querySelectorAll('.upload-item')].filter(x=>x.textContent?.includes('g2-queue-')).every(x=>x.querySelector('.upload-item-target')?.textContent==='其他目录'))()`))===true);

    // ---- G2 phase 3: terminal queue history is removable and never hides
    // actionable uploads. The earlier ten tiny files are deliberately kept
    // across SPA navigation until this final explicit cleanup. ----
    const uploadsSettled=await cdp.waitFor(`()=>{
      const rows=[...document.querySelectorAll('.upload-item')];
      return rows.length===10&&rows.every(row=>row.classList.contains('committed')||row.classList.contains('failed')||row.classList.contains('cancelled'));
    }`,45000);
    const taskStates=await cdp.evaluate(`(()=>[...document.querySelectorAll('.upload-item')].map(x=>x.classList.contains('committed')?'committed':x.classList.contains('failed')?'failed':x.classList.contains('cancelled')?'cancelled':'pending'))()`);
    check("G2 upload history finishes without losing pending files",uploadsSettled===true&&taskStates.length===10,JSON.stringify(taskStates));
    const expectedOutstanding=taskStates.filter(state=>state==="failed").length;
    const clearButton=await cdp.evaluate(`(()=>{const button=document.querySelector('button[aria-label^="清除 "]');if(!button)return false;button.click();return true;})()`);
    await delay(250);
    const remaining=await cdp.evaluate(`(()=>[...document.querySelectorAll('.upload-item')].map(x=>({failed:x.classList.contains('failed'),interrupted:x.classList.contains('interrupted')})))()`);
    check("G2 clear finished history preserves failures while dropping successes",
      clearButton===true&&remaining.length===expectedOutstanding&&remaining.every(item=>item.failed||item.interrupted),JSON.stringify({before:taskStates,remaining}));

    // A tree context operation must relinquish the header after its modal
    // closes; otherwise the header silently keeps targeting the right-clicked
    // folder even while the file list shows another folder.
    await cdp.navigate(`${BASE}/doc?folder=${folderId}`);
    await cdp.waitFor(`()=>!!document.querySelector('li[data-folder-id="${targetId}"]')`,16000);
    await cdp.evaluate(`(()=>{document.querySelector('li[data-folder-id="${targetId}"]>.tree-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:140,clientY:150}));return true;})()`);
    await cdp.waitFor(`()=>!![...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.includes('重命名目录'))`);
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.includes('重命名目录'))?.click();return true;})()`);
    await cdp.waitFor(`()=>!!document.querySelector('#folder-rename-input')`);
    await cdp.evaluate(`(()=>{const d=document.querySelector('#folder-rename-input')?.closest('dialog');[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='取消')?.click();return true;})()`);
    await cdp.waitFor(`()=>!document.querySelector('#folder-rename-input')`);
    await cdp.evaluate(`(()=>{document.querySelector('.folder-more-wrapper .ghost-more-btn')?.click();return true;})()`);
    const currentMenu=await cdp.evaluate(`(()=>document.querySelector('[role=menu][aria-label^="目录操作："]')?.getAttribute('aria-label'))()`);
    check("G2 cancelled tree context operation restores selected folder header",currentMenu===`目录操作：WF-SMOKE-${stamp}`,String(currentMenu));
    await cdp.key("Escape","Escape",27);
    const removable=await mk(`WF-TARGET-${stamp}-REMOVE`);
    await cdp.navigate(`${BASE}/doc?folder=${removable}`);
    await cdp.waitFor(`()=>new URLSearchParams(location.search).get('folder')===${JSON.stringify(removable)}&&!!document.querySelector('.folder-more-wrapper .ghost-more-btn')`);
    await cdp.evaluate(`(()=>{document.querySelector('.folder-more-wrapper .ghost-more-btn')?.click();return true;})()`);
    await cdp.waitFor(`()=>!![...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.includes('删除目录'))`);
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.includes('删除目录'))?.click();return true;})()`);
    await cdp.waitFor(`()=>!![...document.querySelectorAll('dialog[open]')].find(d=>d.textContent?.includes('删除目录确认'))`);
    await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog[open]')].find(x=>x.textContent?.includes('删除目录确认'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认删除')?.click();return true;})()`);
    const fallback=await cdp.waitFor(`()=>new URLSearchParams(location.search).get('folder')===${JSON.stringify(root.id)}`,16000);
    check("G2 deleting selected folder navigates to surviving parent",fallback===true,String(await cdp.evaluate(`(()=>location.pathname+location.search)()`)));

  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
  }

  // crash-safe cleanup
  await json("POST", "/api/logout").catch(() => undefined);
  await json("DELETE", `/api/folders/${folderId}`);
  await json("DELETE", `/api/folders/${targetId}`);
  const probe = (await json("GET", "/api/users")).body?.data?.find((u) => u.login === probeLogin);
  if (probe) await json("POST", `/api/users/${probe.id}/disabled`);
  const trash = await json("GET", "/api/trash");
  for (const entry of trash.body?.data ?? []) {
    const name = String(entry.name ?? entry.oldName ?? "");
    if (name.includes(`WF-SMOKE-${stamp}`) || name.includes(`WF-TARGET-${stamp}`) || name.startsWith(TOKEN) || name === "wf-target.txt" || name === "工作流探针") {
      await json("DELETE", "/api/trash/" + entry.id);
    }
  }
}

async function main() {
  const selectedSuite=opt("suite","all");
  if(!["all","finale"].includes(selectedSuite))throw new Error("only all or finale are supported suite modes");
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
  if(selectedSuite==="all"){
   await runSuite("MOVE", moveSuite);
   await runSuite("MOVEUI", moveUiSuite);
   await runSuite("WORKFLOW", workflowSuite);
   await runSuite("SAFE-EDIT", safeEditSuite);
   await runSuite("G4UI", g4UiSuite);
   await runSuite("BATCHUI", batchUiSuite);
  }
  await runSuite("FINALE", finaleSuite);

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("UX_WORKFLOWS_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log(selectedSuite==="all"?"UX_WORKFLOWS_PASS":"UX_WORKFLOWS_FINALE_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
