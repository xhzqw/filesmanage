// Static scope contract for Workbench V2. Keep Finder/file preview isolated.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const finder=[
 "web/src/pages/Documents.tsx",
 "web/src/pages/Preview.tsx",
 "web/src/features/collaboration/FinderSidebar.tsx",
 "web/src/features/collaboration/finderSidebar.css"
];
for(const path of finder){
 const source=read(path);
 assert.ok(!/KnowledgeFinderRail|\/knowledge|kn-finder|knowledge-home-link/i.test(source),
  "Workbench knowledge feature must not alter Finder or preview: "+path);
}
const shell=read("web/src/shared/ui/AppShell.tsx");
assert.match(shell,/to:"\/doc",label:"文档管理"/);
assert.match(shell,/to:"\/workbench",label:"工作台"/);
assert.doesNotMatch(shell,/to:"\/knowledge",label:/);
const app=read("web/src/app/App.tsx");
assert.match(app,/LegacyKnowledgeRedirect/);
assert.match(app,/query\.set\("view","knowledge"\)/);
const wb=read("web/src/pages/CDWWorkbench.tsx");
for(const component of ["WorkbenchFocusHome","WorkbenchApprovals","WorkbenchDHFOperations","KnowledgeWorkspace"]){
 assert.match(wb,new RegExp(component),"Workbench must render "+component);
}
assert.match(wb,/filter==="knowledge"/);
assert.match(wb,/embedded\s*\/>/);
assert.match(wb,/viewGroups/);
assert.match(wb,/setParams\(prev/);
assert.match(wb,/observeWorkspaceChange/);
assert.match(wb,/observeWindowReturn/);
assert.match(wb,/filesmanage:approvals-changed/);
const primary=wb.slice(wb.indexOf('const viewGroups:'),wb.indexOf('const kindName:'));
assert.match(primary,/name:"常用"/);
assert.match(primary,/name:"更多业务"/);
assert.match(primary,/key:"home",label:"我的工作"/);
assert.match(primary,/key:"projects",label:"项目"/);
assert.match(primary,/key:"knowledge",label:"知识"/);
assert.match(wb,/const legacyViews:/);
assert.match(wb,/const isKnownView=/);
assert.doesNotMatch(primary,/label:"履责待办"|label:"交付验收"|label:"范围审批"/);
const focus=read("web/src/pages/WorkbenchFocusHome.tsx");
assert.match(focus,/wbf-worklist/);
assert.doesNotMatch(focus,/wbv2-metrics|wbv2-shortcuts|wbv2-right-rail|DHFHomeProjects/);
const knowledge=read("web/src/pages/KnowledgeWorkspace.tsx");
assert.match(knowledge,/embedded\?\s*:\s*boolean/);
assert.match(knowledge,/embedded \? content/);
const ops=read("web/src/pages/WorkbenchDHFOperations.tsx");
for(const section of ["DHFPilotInbox","DHFVerificationInbox","DHFGateDecisionReviewInbox","DHFConditionalRemediationPlans"]){
 assert.ok(ops.includes(section),"DHF workflow missing: "+section);
}
console.log("WORKBENCH_REDUCTION_SCOPE_OK: Finder untouched; Workbench has 3 primary views and one focused task list");
