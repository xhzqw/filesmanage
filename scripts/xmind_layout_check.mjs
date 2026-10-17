#!/usr/bin/env node
// Deterministic layout regression: no private data, browser, DB or service needed.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import ts from "../web/node_modules/typescript/lib/typescript.js";

const source=readFileSync(resolve("web/src/features/documents/mindMapLayout.ts"),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {layoutMindMap,indexMindMap,MIND_NODE_WIDTH,MIND_NODE_HEIGHT}=
 await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const topic=(title,children=[])=>({title,children});
const root=topic("DHF 1–9",Array.from({length:13},(_,i)=>
 topic("阶段 "+(i+1),Array.from({length:3},(_,j)=>
  topic("验收 "+(i+1)+"."+j,[topic("文件审核"),topic("签收记录")])))));
const indexed=indexMindMap(root);
assert.equal(indexed.length,1+13*(1+3*(1+2)));
const check=(layout)=>{
 assert.equal(layout.edges.length,layout.nodes.length-1);
 const locations=new Set();
 for(const item of layout.nodes){
  assert.ok(Number.isFinite(item.x)&&Number.isFinite(item.y));
  assert.ok(item.x>=0&&item.y>=0);
  assert.ok(item.x+MIND_NODE_WIDTH<=layout.width&&item.y+MIND_NODE_HEIGHT<=layout.height);
  const key=item.x+"|"+item.y;
  assert.ok(!locations.has(key),"overlapping node at "+key);
  locations.add(key);
 }
 for(const edge of layout.edges){
  for(const v of [edge.fromX,edge.toX]){
   assert.ok(v>=0&&v<=layout.width,"edge x outside view "+v);
  }
  for(const v of [edge.fromY,edge.toY]){
   assert.ok(v>=0&&v<=layout.height,"edge y outside view "+v);
  }
 }
 for(let i=0;i<layout.nodes.length;i++)for(let j=i+1;j<layout.nodes.length;j++){
  const a=layout.nodes[i],b=layout.nodes[j];
  const intersect=a.x<b.x+MIND_NODE_WIDTH&&a.x+MIND_NODE_WIDTH>b.x&&
   a.y<b.y+MIND_NODE_HEIGHT&&a.y+MIND_NODE_HEIGHT>b.y;
  assert.ok(!intersect,"node collision: "+a.path+" vs "+b.path);
 }
};
const balanced=layoutMindMap(root,new Set(),"balanced");
const right=layoutMindMap(root,new Set(),"right");
check(balanced);check(right);
assert.ok(balanced.nodes.some(n=>n.x<balanced.nodes[0].x),"left branches missing");
assert.ok(balanced.nodes.some(n=>n.x>balanced.nodes[0].x),"right branches missing");
assert.ok(right.nodes.every(n=>n.x>=right.nodes[0].x),"right-only layout leaks left branch");
assert.equal(JSON.stringify(balanced),JSON.stringify(layoutMindMap(root,new Set(),"balanced")),"layout nondeterministic");
const collapsed=layoutMindMap(root,new Set(["0.0","0.1","0.2"]),"balanced");
check(collapsed);assert.ok(collapsed.nodes.length<balanced.nodes.length);
const center=layoutMindMap(topic("single"),new Set(),"balanced");
check(center);assert.equal(center.nodes.length,1);
const broad=layoutMindMap(topic("root",Array.from({length:800},(_,i)=>topic(String(i)))),new Set(),"balanced");
check(broad);assert.equal(broad.nodes.length,801);
console.log("XMIND_LAYOUT_PASS balanced / directional / fold / collision / bounds / deterministic / 800 branches");
