#!/usr/bin/env node
// Rare Workbench primitive ownership gate. Feature JSX may not re-create
// the baseline native controls: all states/geometry flow through RareControls.
import {readdirSync,readFileSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const src=join(root,"web","src");
const errors=[];
let checked=0;
function walk(dir){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  if(entry.isDirectory()){walk(path);continue;}
  // RareSelect owns its hidden native select, trigger and portaled options.
  if(!entry.name.endsWith(".tsx")||path.endsWith("/rare/RareControls.tsx")||path.endsWith("/rare/RareSelect.tsx"))continue;
  checked++;
  const source=readFileSync(path,"utf8");
  const native=/<(button|input|select|textarea)(?=[\s/>])/g;
  for(const hit of source.matchAll(native)){
   const line=source.slice(0,hit.index).split("\n").length;
   errors.push(`${relative(root,path)}:${line}: native <${hit[1]}> bypasses RareControls`);
  }
 }
}
walk(src);
for(const [path,name] of [
 ["web/src/shared/ui/AppShell.tsx","Menu"],
 ["web/src/features/folders/FolderActions.tsx","Menu"],
 ["web/src/pages/SessionDevices.tsx","Dialog"],
 ["web/src/features/organization/OrganizationPanel.tsx","RareTabs"],
 ["web/src/features/organization/OrganizationPanel.tsx","RareBadge"],
 ["web/src/features/organization/PermissionsPanel.tsx","RareNotice"],
 ["web/src/features/trash/TrashList.tsx","RareNotice"],
]){
 if(!readFileSync(join(root,path),"utf8").includes(`<${name} `))errors.push(`${path}: must render shared ${name}`);
}
// A shared feedback style must never be redefined in a feature stylesheet.
const organizationCss=readFileSync(join(root,"web/src/features/organization/organization.css"),"utf8");
if(/\.org-badge(?:-success|-warning|-disabled|-admin|-dot)?\s*\{/.test(organizationCss)){
 errors.push("organization.css: semantic badges must be owned by RareFeedback");
}
const sharedExports=readFileSync(join(root,"web/src/shared/ui/rare/index.ts"),"utf8");
for(const symbol of ["RareBadge","RareNotice"]){
 if(!sharedExports.includes(symbol))errors.push(`rare/index.ts: ${symbol} is not exported`);
}
// Single-owner ACL UI contract: quick grant, directory grant and delegated
// admin may differ in *workflow*, never by reimplementing a checkbox matrix.
for(const path of [
 "web/src/features/organization/DirectGrantForm.tsx",
 "web/src/features/organization/QuickGrantsDialog.tsx",
 "web/src/features/organization/RoleDelegationEditor.tsx",
]){
 const source=readFileSync(join(root,path),"utf8");
 if(!source.includes("<PermissionActionPicker "))errors.push(`${path}: must use shared PermissionActionPicker`);
 if(/(?:PERMISSION_ACTIONS|actionChoices|ACTIONS)\.map\([^)]*=>\s*<label/.test(source))
  errors.push(`${path}: duplicate ACL option markup; use PermissionActionPicker`);
}
for(const path of [
 "web/src/features/organization/DirectGrantForm.tsx",
 "web/src/features/organization/QuickGrantsDialog.tsx",
]){
 const source=readFileSync(join(root,path),"utf8");
 for(const symbol of ["PermissionGrantSubjectFields","PermissionGrantScopeFields"]){
  if(!source.includes(`<${symbol} `))errors.push(`${path}: missing shared ${symbol}`);
 }
}
if(/const ACTIONS\s*=\s*\[/.test(readFileSync(join(root,"web/src/features/organization/QuickGrantsDialog.tsx"),"utf8")))
 errors.push("QuickGrantsDialog.tsx: duplicated permission action dictionary");
const quickGrants=readFileSync(join(root,"web/src/features/organization/QuickGrantsDialog.tsx"),"utf8");
if(/quick-grants-close/.test(quickGrants))errors.push("QuickGrantsDialog.tsx: duplicate close control; use the Dialog header dismiss");
const statsPanel=readFileSync(join(root,"web/src/features/collaboration/StatsPanel.tsx"),"utf8");
if((statsPanel.match(/<MetricSwitch /g)||[]).length!==1)errors.push("StatsPanel.tsx: render exactly one shared metric switch");
if(errors.length){
 for(const error of errors)console.error("COMPONENT_GOVERNANCE_FAIL",error);
 process.exitCode=1;
}else console.log(`COMPONENT_GOVERNANCE_PASS ${checked} TSX modules; RareControls and shared overlays enforced`);
