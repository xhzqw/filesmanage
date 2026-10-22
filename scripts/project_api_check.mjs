#!/usr/bin/env node
// End-to-end check of the project database API against the running dev
// instance. Exercises every endpoint in BACKEND-API.md §3–§5 and asserts the
// exact contract the frontend depends on (envelope, asOf, date-only strings,
// idempotent batch links, per-user view state).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const base = (process.argv[2] || "http://127.0.0.1:18091").replace(/\/+$/, "");
const password = readFileSync(process.argv[3] || ".secrets/admin.password", "utf8").trim();

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: {"Content-Type": "application/json", ...(cookie ? {Cookie: cookie} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const item of setCookie) {
    if (item.startsWith("fm_session=")) cookie = item.split(";")[0];
  }
  let reply = null;
  try { reply = await res.json(); } catch { reply = null; }
  return {status: res.status, reply};
}

function ok(result, label, expected = 200) {
  assert.equal(result.status, expected, `${label}: status ${result.status} body ${JSON.stringify(result.reply)}`);
  assert.equal(result.reply?.ok, true, `${label}: envelope not ok ${JSON.stringify(result.reply)}`);
  return result.reply.data;
}

function fails(result, label, status, code) {
  assert.equal(result.status, status, `${label}: status ${result.status} body ${JSON.stringify(result.reply)}`);
  assert.equal(result.reply?.ok, false, `${label}: expected failure envelope`);
  assert.equal(result.reply?.error?.code, code, `${label}: code ${result.reply?.error?.code}`);
  assert.ok(result.reply?.error?.message?.length > 0, `${label}: error.message missing`);
}

const login = await call("POST", "/login", {login: "admin", password});
ok(login, "login");
assert.ok(cookie, "session cookie issued");

// --- list / detail defaults -------------------------------------------------
// A previous session may already have saved a view (the workbench writes one on
// every filter/view change), so only the shape is asserted here; the round trip
// below proves the read/write contract either way.
const initialView = ok(await call("GET", "/projects/view-state"), "view-state before save");
assert.ok(initialView.config === null || typeof initialView.config === "object", "view-state is null or an object");
// The workbench saves a view for admin whenever filters change, so this check
// restores whatever was there instead of leaving a test view behind.
const originalView = initialView.config;

const listBefore = ok(await call("GET", "/projects"), "list");
assert.ok(Array.isArray(listBefore.items), "items array");
assert.equal(typeof listBefore.asOf, "string");
assert.ok(!Number.isNaN(Date.parse(listBefore.asOf)), "asOf must be an ISO timestamp");
assert.equal(listBefore.nextCursor, null, "nextCursor must be null on a single page");
const beforeCount = listBefore.items.length;

// --- create (full drawer payload) -------------------------------------------
const created = ok(await call("POST", "/projects", {
  name: "  自动化验收项目  ", icon: "◈", description: "BACKEND-API 验收",
  status: "progress", priority: "high", team: "工程部",
  startDate: "2026-11-02", endDate: "2026-12-15", progress: 35,
}), "create", 201).project;
assert.equal(created.name, "自动化验收项目", "name must be trimmed");
assert.equal(created.icon, "◈");
assert.equal(created.ownerName, "", "unassigned owner has empty display name");
assert.equal(created.startDate, "2026-11-02", "startDate must be a date-only string");
assert.equal(created.endDate, "2026-12-15");
assert.equal(created.archived, false);
assert.deepEqual([created.comments.length, created.todos.length, created.docs.length], [0, 0, 0]);
assert.equal(typeof created.createdAt, "number");
assert.equal(typeof created.updatedAt, "number");

// --- validation failures ----------------------------------------------------
fails(await call("POST", "/projects", {name: "   "}), "blank name", 400, "E_INVALID_INPUT");
fails(await call("POST", "/projects", {name: "反序", startDate: "2026-05-10", endDate: "2026-05-01"}), "end before start", 400, "E_INVALID_INPUT");
fails(await call("POST", "/projects", {name: "越界", progress: 101}), "progress range", 400, "E_INVALID_INPUT");
fails(await call("POST", "/projects", {name: "坏状态", status: "blocked"}), "unknown status", 400, "E_INVALID_INPUT");
fails(await call("POST", "/projects", {name: "坏日期", startDate: "2026-02-31"}), "impossible date", 400, "E_INVALID_INPUT");

// --- owner join via the real organization directory -------------------------
const users = await call("GET", "/users?limit=200");
assert.equal(users.status, 200, "organization /users must stay usable for the owner dropdown");
const adminUser = users.reply.data.items.find((u) => u.login === "admin");
assert.ok(adminUser, "admin user present in /users page");
const owned = ok(await call("PATCH", `/projects/${created.id}`, {ownerId: adminUser.id}), "set owner").project;
assert.equal(owned.ownerId, adminUser.id);
assert.equal(owned.ownerName, adminUser.displayName, "ownerName must be joined from users");

// --- inline edits, gantt drag, favorite, archive ----------------------------
const dragged = ok(await call("PATCH", `/projects/${created.id}`, {status: "done", progress: 100}), "status+progress").project;
assert.equal(dragged.status, "done");
assert.equal(dragged.progress, 100);
assert.equal(dragged.name, "自动化验收项目", "unpatched fields survive");
assert.equal(dragged.team, "工程部");
const moved = ok(await call("PATCH", `/projects/${created.id}`, {startDate: "2026-11-09", endDate: "2026-12-22"}), "gantt dates").project;
assert.deepEqual([moved.startDate, moved.endDate], ["2026-11-09", "2026-12-22"]);
const fav = ok(await call("PATCH", `/projects/${created.id}`, {favorite: true}), "favorite").project;
assert.equal(fav.favorite, true);
fails(await call("PATCH", `/projects/${created.id}`, {startDate: "2027-01-01"}), "start after stored end", 400, "E_INVALID_INPUT");

// --- sub-resources ----------------------------------------------------------
const comment = ok(await call("POST", `/projects/${created.id}/comments`, {text: "  验收评论  "}), "comment", 201).comment;
assert.equal(comment.text, "验收评论", "comment text trimmed");
assert.ok(comment.who.length > 0 && comment.whoId === adminUser.id, "comment carries author name and id");
assert.ok(comment.at.length > 0 && typeof comment.createdAt === "number");
fails(await call("POST", `/projects/${created.id}/comments`, {text: "   "}), "blank comment", 400, "E_INVALID_INPUT");

const todoReply = ok(await call("POST", `/projects/${created.id}/todos`, {text: "核对迁移清单"}), "todo add", 201);
assert.equal(todoReply.ok, true);
const detailAfterTodo = ok(await call("GET", `/projects/${created.id}`), "detail after todo").project;
const todo = detailAfterTodo.todos.find((t) => t.text === "核对迁移清单");
assert.ok(todo && todo.done === false, "todo created open");
ok(await call("PATCH", `/projects/${created.id}/todos/${todo.id}`, {done: true}), "todo done");
const afterDone = ok(await call("GET", `/projects/${created.id}`), "detail after done").project;
assert.equal(afterDone.todos.find((t) => t.id === todo.id).done, true);
fails(await call("PATCH", `/projects/${created.id}/todos/999999`, {done: true}), "unknown todo", 404, "E_NOT_FOUND");

// --- document links from a real controlled file ----------------------------
const folders = await call("GET", "/folders/tree");
assert.equal(folders.status, 200, "folder tree readable for the picker");
let fileId = null, fileName = null, folderId = null;
for (const folder of folders.reply.data ?? []) {
  const files = await call("GET", `/files?folder=${encodeURIComponent(folder.id)}&sort=name_asc&limit=20`);
  if (files.status !== 200 || !files.reply.data.items?.length) continue;
  // Pick a PDF/office-ish file so the kind mapping is exercised meaningfully.
  const pick = files.reply.data.items.find((f) => /\.(pdf|docx?)$/i.test(f.name)) ?? files.reply.data.items[0];
  fileId = pick.id; fileName = pick.name; folderId = folder.id;
  break;
}
assert.ok(fileId, "a real controlled file exists for the link test (upload at least one file)");
const single = ok(await call("POST", `/projects/${created.id}/docs`, {
  docId: fileId, name: "旧名字.pdf", kind: /\.pdf$/i.test(fileName) ? "pdf" : "file",
}), "single doc link", 201);
assert.equal(single.ok, true);
assert.equal(single.added, 1);
const relink = ok(await call("POST", `/projects/${created.id}/docs`, {
  docId: fileId, name: "旧名字.pdf", kind: /\.pdf$/i.test(fileName) ? "pdf" : "file",
}), "idempotent relink", 201);
assert.equal(relink.added, 0, "re-linking the same document must not report a new row");
const batch = ok(await call("POST", `/projects/${created.id}/docs/batch`, {
  docs: [
    {docId: "acceptance-missing-doc", name: "手册.docx", kind: "file"},
    {docId: "acceptance-missing-doc", name: "手册.docx", kind: "file"},
  ],
}), "batch link", 201);
assert.equal(batch.added, 1, "duplicate ids in one batch collapse");
const batchAgain = ok(await call("POST", `/projects/${created.id}/docs/batch`, {
  docs: [{docId: "acceptance-missing-doc", name: "手册.docx", kind: "file"}],
}), "batch relink", 201);
assert.equal(batchAgain.added, 0, "batch relink is idempotent, not 409");
fails(await call("POST", `/projects/${created.id}/docs/batch`, {docs: [
  {docId: "acceptance-partial", name: "a.pdf", kind: "pdf"},
  {docId: "acceptance-bad", name: "b.exe", kind: "exe"},
]}), "invalid batch", 400, "E_INVALID_INPUT");

const withDocs = ok(await call("GET", `/projects/${created.id}`), "detail with docs").project;
assert.equal(withDocs.docs.length, 2, "only the two accepted links exist");
const liveDoc = withDocs.docs.find((d) => d.docId === fileId);
assert.equal(liveDoc.name, fileName, "the live file name must win over the stored fallback");
const orphan = withDocs.docs.find((d) => d.docId === "acceptance-missing-doc");
assert.equal(orphan.name, "手册.docx", "stored name is the fallback when no file exists");
assert.ok(withDocs.comments.length === 1 && withDocs.todos.length === 1);

ok(await call("DELETE", `/projects/${created.id}/docs/${encodeURIComponent("acceptance-missing-doc")}`), "unlink");
fails(await call("DELETE", `/projects/${created.id}/docs/${encodeURIComponent("acceptance-missing-doc")}`), "unlink again", 404, "E_NOT_FOUND");
ok(await call("DELETE", `/projects/${created.id}/todos/${todo.id}`), "todo delete");
fails(await call("DELETE", `/projects/${created.id}/todos/${todo.id}`), "todo delete again", 404, "E_NOT_FOUND");

// --- view state -------------------------------------------------------------
const view = {
  colVis: {status: true, owner: true, priority: true, team: false, start: true, end: true, progress: true},
  sort: {field: "priority", dir: -1},
  filters: {status: {notstarted: true, progress: true, done: false}},
  scope: "mine", view: "gantt", columnConfig: {ganttScale: 1},
};
ok(await call("PUT", "/projects/view-state", view), "view state save");
const savedView = ok(await call("GET", "/projects/view-state"), "view state read").config;
assert.deepEqual(savedView, view, "view state round trip");
ok(await call("PUT", "/projects/view-state", {view: "board", scope: "all"}), "view state overwrite");
const overwritten = ok(await call("GET", "/projects/view-state"), "view state re-read").config;
assert.deepEqual(overwritten, {view: "board", scope: "all"}, "last PUT wins as a whole-object overwrite");
fails(await call("PUT", "/projects/view-state", null), "null view state", 400, "E_INVALID_INPUT");
if (originalView) ok(await call("PUT", "/projects/view-state", originalView), "view state restored");

// --- list ordering and archive exclusion -----------------------------------
const listAfter = ok(await call("GET", "/projects"), "list after writes");
assert.equal(listAfter.items.length, beforeCount + 1, "new live project appears exactly once");
assert.ok(listAfter.items.some((p) => p.id === created.id));
const stamps = listAfter.items.map((p) => p.updatedAt);
assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), "list is ordered by updatedAt descending");

const archived = ok(await call("PATCH", `/projects/${created.id}`, {archived: true}), "archive").project;
assert.equal(archived.archived, true);
const listArchived = ok(await call("GET", "/projects"), "list after archive");
assert.ok(!listArchived.items.some((p) => p.id === created.id), "archived projects disappear from the list");
const stillReadable = ok(await call("GET", `/projects/${created.id}`), "archived detail").project;
assert.equal(stillReadable.archived, true);
assert.equal(stillReadable.comments.length, 1, "archive keeps sub-resources");

// --- delete (soft) ----------------------------------------------------------
const deleted = ok(await call("DELETE", `/projects/${created.id}`), "delete");
assert.equal(deleted.ok, true);
assert.equal(deleted.archived, true);
const afterDelete = ok(await call("GET", `/projects/${created.id}`), "detail after delete").project;
assert.equal(afterDelete.archived, true, "delete archives rather than removing");
fails(await call("GET", "/projects/999999999"), "unknown project", 404, "E_NOT_FOUND");
fails(await call("GET", "/projects/not-a-number"), "bad id", 400, "E_INVALID_INPUT");

console.log(`PROJECT_API_PASS projects=${listAfter.items.length} linkedDoc=${fileId} folder=${folderId}`);
