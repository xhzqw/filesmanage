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
  if(!entry.name.endsWith(".tsx")||path.endsWith("/rare/RareControls.tsx"))continue;
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
]){
 if(!readFileSync(join(root,path),"utf8").includes(`<${name} `))errors.push(`${path}: must render shared ${name}`);
}
if(errors.length){
 for(const error of errors)console.error("COMPONENT_GOVERNANCE_FAIL",error);
 process.exitCode=1;
}else console.log(`COMPONENT_GOVERNANCE_PASS ${checked} TSX modules; RareControls and shared overlays enforced`);
