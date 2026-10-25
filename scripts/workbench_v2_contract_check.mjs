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
for(const component of ["WorkbenchCommandCenter","WorkbenchApprovals","WorkbenchDHFOperations","KnowledgeWorkspace"]){
 assert.match(wb,new RegExp(component),"Workbench must render "+component);
}
assert.match(wb,/filter==="knowledge"/);
assert.match(wb,/embedded\s*\/>/);
assert.match(wb,/viewGroups/);
assert.match(wb,/setParams\(prev/);
assert.match(wb,/observeWorkspaceChange/);
assert.match(wb,/observeWindowReturn/);
assert.match(wb,/filesmanage:approvals-changed/);
const knowledge=read("web/src/pages/KnowledgeWorkspace.tsx");
assert.match(knowledge,/embedded\?\s*:\s*boolean/);
assert.match(knowledge,/embedded \? content/);
const ops=read("web/src/pages/WorkbenchDHFOperations.tsx");
for(const section of ["DHFPilotInbox","DHFVerificationInbox","DHFGateDecisionReviewInbox","DHFConditionalRemediationPlans"]){
 assert.ok(ops.includes(section),"DHF workflow missing: "+section);
}
console.log("WORKBENCH_V2_SCOPE_OK: Finder untouched; authenticated workflows and knowledge live inside Workbench");
