#!/usr/bin/env node
/*
 * Visual System V3 static contract.
 *
 * Independent feature components own their surface geometry. Every radius
 * they declare must reference a shared token, except true circles (50%) and
 * nested surfaces that explicitly inherit an ancestor's clipping radius.
 * The root shell in theme.css and the feature styles must use the same V3
 * tokens. Splitting a token across theme.css and visualSystem.css is forbidden.
 */
import {readdirSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join,relative,resolve} from "node:path";

const projectRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const cssRoot=join(projectRoot,"web","src");
const errors=[];
const scanned=[];
// Zero means a welded interior rail, not an arbitrary component radius.
const allowed=/^(?:var\(--radius-(?:xs|sm|md|lg|xl|pill|control|surface|finder)\)|inherit|50%|0)$/;

function walk(dir){
 for(const item of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,item.name);
  if(item.isDirectory()){walk(path);continue;}
  if(!item.isFile()||!item.name.endsWith(".css"))continue;
  scanned.push(relative(projectRoot,path));
  const source=readFileSync(path,"utf8").replace(/\/\*[\s\S]*?\*\//g,"");
  for(const match of source.matchAll(/(?:^|[;{\s])border-radius\s*:\s*([^;}]+)/g)){
   const expression=match[1].trim();
   if(allowed.test(expression))continue;
   const line=source.slice(0,match.index).split("\n").length;
   errors.push(`${relative(projectRoot,path)}:${line}: unsupported border-radius ${expression}`);
  }
 }
}
walk(join(cssRoot,"features"));
walk(join(cssRoot,"shared"));
walkTheme();

function walkTheme(){
 const themePath=join(cssRoot,"theme.css");
 const theme=readFileSync(themePath,"utf8");
 const uncommented=theme.replace(/\/\*[\s\S]*?\*\//g,"");
 scanned.push(relative(projectRoot,themePath));
 for(const match of uncommented.matchAll(/(?:^|[;{\s])border-radius\s*:\s*([^;}]+)/g)){
  if(allowed.test(match[1].trim()))continue;
  const line=uncommented.slice(0,match.index).split("\n").length;
  errors.push(`theme.css:${line}: unsupported border-radius ${match[1].trim()}`);
 }
 const expected={xs:"4px",finder:"6px","finder-canvas":"10px",sm:"7px",md:"11px",lg:"15px",xl:"20px",pill:"999px"};
 for(const [name,value] of Object.entries(expected)){
  const occurrences=[...uncommented.matchAll(new RegExp(`--radius-${name}\\s*:\\s*([^;]+)`, "g"))];
  if(occurrences.length!==1||occurrences[0][1].trim()!==value){
   errors.push(`theme.css: --radius-${name} must be declared exactly once as ${value}`);
  }
 }
 for(const name of ["panel","overlay"]){
  if(!uncommented.includes(`--shadow-${name}:`)){
   errors.push(`theme.css: --shadow-${name} is missing`);
  }
 }
}

// Component-owned selectors must not be duplicated in the global override.
// Responsive composition rules (e.g. .media-preview{margin:4px} inside a
// media query) are intentionally allowed: they own layout, not geometry.
const system=readFileSync(join(cssRoot,"visualSystem.css"),"utf8");
if(/--(?:radius|shadow)-(?:xs|sm|md|lg|xl|pill|panel|overlay)\s*:/.test(system)){
 errors.push("visualSystem.css: shared tokens must be defined only in theme.css");
}
const ownership=[
 ".menu",".menu-item",".command-panel",".command-row",
 ".org-card",".org-tabs-nav",".org-tab",".media-preview",".dropzone",
 ".upload-queue",".share-workbench",".perm-workspace",".perm-tree-row",
 ".perm-result",".perm-review",".version-badge",
];
const rule=/([^{}]+)\{([^{}]*)\}/g;
for(const match of system.matchAll(rule)){
 const selectors=match[1].replace(/\/\*[\s\S]*?\*\//g,"").trim().split(",").map(s=>s.trim());
 if(!selectors.some(s=>ownership.some(owned=>s===owned)))continue;
 if(!/\b(?:border-radius|box-shadow)\s*:/.test(match[2]))continue;
 errors.push(`visualSystem.css: component-owned geometry duplicated in ${selectors.join(", ")}`);
}
if(errors.length){
 for(const err of errors)console.error("STYLE_GOVERNANCE_FAIL",err);
 process.exitCode=1;
}else{
 console.log(`STYLE_GOVERNANCE_PASS ${scanned.length} component stylesheets; tokens and geometry ownership valid`);
}
