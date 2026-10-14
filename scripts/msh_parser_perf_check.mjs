#!/usr/bin/env node
// Deterministic 120,000-triangle MSH 2.2 CPU and memory-budget smoke test.
// Run on remote target using Node 22 TS type stripping, not on source Mac.
import {performance} from "node:perf_hooks";
import {parseMshAssembly,MshLimitError} from "../web/src/features/modelViewer/mshParser.ts";

const width=200,height=150;
const nodesPerPart=(width+1)*(height+1);
const trianglesPerPart=2*width*height;
const lines=["$MeshFormat","2.2 0 8","$EndMeshFormat","$Nodes",String(nodesPerPart*2)];
const id=(part,x,y)=>part*nodesPerPart+y*(width+1)+x+1;
for(let part=0;part<2;part++){
 for(let y=0;y<=height;y++)for(let x=0;x<=width;x++){
  lines.push(`${id(part,x,y)} ${part*300+x} ${y} 0`);
 }
}
lines.push("$EndNodes","$Elements",String(trianglesPerPart*2));
let element=0;
for(let part=0;part<2;part++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
 const a=id(part,x,y),b=id(part,x+1,y),c=id(part,x,y+1),d=id(part,x+1,y+1);
 lines.push(`${++element} 2 2 1 0 ${a} ${b} ${c}`);
 lines.push(`${++element} 2 2 1 0 ${b} ${d} ${c}`);
}
lines.push("$EndElements","");
const bytes=new TextEncoder().encode(lines.join("\n"));
const start=performance.now();
const {parts,triangleCount}=parseMshAssembly(bytes.buffer);
const elapsedMs=Math.round(performance.now()-start);
function check(assertion,message){
 if(!assertion)throw Error("MSH_PARSER_FAIL "+message);
 console.log("PASS "+message);
}
check(triangleCount===120000,"120k triangles retained");
check(parts.length===2&&parts.every(p=>p.triangles===60000),
 "two disconnected assemblies preserved");
check(parts.every(p=>p.bounds[3]-p.bounds[0]===200&&
 p.bounds[4]-p.bounds[1]===150),"exact bounding boxes");
check(parts.every(p=>p.positions.length===540000&&p.normals.length===540000),
 "typed geometry and normal buffers allocated once per part");
check(parts.every(p=>p.normals[2]===1),"flat normals have correct orientation");
check(elapsedMs<12000,"CPU parser upper limit 12s (target-only), observed "+elapsedMs+"ms");
for(const value of ["4.1 0 8","2.2 1 8"]){
 const bad=new TextEncoder().encode(lines.join("\n").replace("2.2 0 8",value));
 try{parseMshAssembly(bad.buffer);throw Error("accepted unsupported format");}
 catch(error){check(error.message!=="accepted unsupported format","reject unsupported MSH "+value);}
}
const malformed=new TextEncoder().encode("$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n3000001\n$EndNodes\n$Elements\n0\n$EndElements\n");
try{parseMshAssembly(malformed.buffer);throw Error("accepted unbounded node count");}
catch(error){check(error instanceof MshLimitError,"reject oversized mesh metadata");}
console.log(`MSH_PARSER_PERF_PASS triangles=${triangleCount} bytes=${bytes.byteLength} elapsed_ms=${elapsedMs}`);
