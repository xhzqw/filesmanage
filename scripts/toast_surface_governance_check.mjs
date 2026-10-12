#!/usr/bin/env node
// Prevent transient write outcomes from reintroducing page-wide banners in
// parallel with global Rare Toast. Inline actionable errors are intentional.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

function source(path){
 return readFileSync(new URL("../web/src/"+path,import.meta.url),"utf8");
}
function absent(path,patterns){
 const body=source(path);
 for(const [pattern,description] of patterns){
  assert.ok(!pattern.test(body),path+": "+description);
 }
 return body;
}
const approval=absent("features/workflow/ApprovalInbox.tsx",[
 [/approval-notice/,"old approval result banner"],
 [/setMessage\(/,"duplicate operation message state"],
]);
assert.match(approval,/toast\.success\("审批已拒绝/,"rejection must still acknowledge completion");
assert.match(approval,/toast\.warning\("网络中断，审批结果未确认/,"unknown approval outcome must remain a warning");

const collab=absent("features/collaboration/CollaborationPanel.tsx",[
 [/setMessage\(/,"duplicate shared/favorite result banner"],
 [/className=\{"notice"\+\(messageTone/,"full-width result notice"],
]);
assert.match(collab,/toast\.warning/,"network uncertainty must still be surfaced");

const search=source("features/collaboration/SearchPanel.tsx");
assert.doesNotMatch(search,/setMessage\(`已同步搜索条件/,"preset save should only use Toast");
assert.doesNotMatch(search,/setMessage\("预设已加载/,"preset loading should only use Toast");
assert.match(search,/setMessage\("开始日期不能晚于结束日期"\)/,"actionable form errors must stay inline");

const lifecycle=absent("features/documents/LifecyclePolicyManager.tsx",[
 [/setNotice\(/,"second policy save notification"],
 [/\{notice&&/,"second policy save banner"],
]);
assert.match(lifecycle,/errorToast:false/,"actionable policy errors belong inline, not twice");

const editor=source("features/documents/FileEditor.tsx");
assert.doesNotMatch(editor,/setMessage\(`已保存为/,"successful save must not create a second banner");
assert.match(editor,/setMessage\(detail\)/,"failed save still needs actionable inline context");

const preview=source("pages/Preview.tsx");
assert.doesNotMatch(preview,/setNotice\(/,"preview must not stack action completion banners");
assert.match(preview,/error&&<p role="alert"/,"preview keeps persistent actionable errors");

const seals=source("features/seals/FileSealsPanel.tsx");
assert.doesNotMatch(seals,/setNotice\(/,"signed PDF result must not create a second banner");
assert.match(seals,/toast\.success\("签署记录已保存"/);

const trash=source("features/trash/TrashWorkbench.tsx");
assert.match(trash,/tone==="success"\?null:/,"fully successful trash actions must not create a second banner");
assert.match(trash,/warning:tone==="warning"/,"partial results must remain visible as detail");

const org=source("features/organization/OrganizationPanel.tsx");
assert.match(org,/notice&&notice\.tone!=="error"/,"persistent organization validation should not double-announce");

console.log("TOAST_BUSINESS_SURFACE_PASS: approval, sharing, search, lifecycle, editor, preview, signing, trash, organization");
