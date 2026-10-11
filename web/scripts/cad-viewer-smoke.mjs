// Run on the remote target only: node web/scripts/cad-viewer-smoke.mjs
// DXF model-space regression: layer metadata, units, batched lines,
// polyline bulges and annotation glyphs.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";
import * as THREE from "three";

// The parser's Three dependency is type-only; esbuild erases it.
const raw=readFileSync(new URL("../src/features/modelViewer/dxf.ts",import.meta.url),"utf8");
const compiled=await transform(raw,{loader:"ts",format:"esm",target:"es2022"});
const {parseDxf}=await import("data:text/javascript;base64,"+Buffer.from(compiled.code).toString("base64"));

const context={
 font:"",textBaseline:"top",fillStyle:"",
 measureText:(s)=>({width:s.length*32}),
 fillText:()=>{},
};
globalThis.document={createElement:()=>({
 width:0,height:0,getContext:()=>context,
})};

const dxf=[
 "0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC",
 "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
 "0","LAYER","2","CUT","62","7","70","0",
 "0","LAYER","2","HIDDEN","62","1","70","1",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","LINE","8","CUT","10","0","20","0","11","20","21","0",
 "0","LWPOLYLINE","8","CUT","70","0",
 "10","0","20","0","42","1","10","10","20","0",
 "0","TEXT","8","CUT","10","5","20","5","40","2","1","A-01",
 "0","LINE","8","HIDDEN","10","0","20","0","11","3","21","3",
 "0","ENDSEC","0","EOF",
].join("\n");
const parsed=parseDxf(dxf,THREE);
assert.equal(parsed.unit,"mm");
assert.deepEqual(parsed.layers,[
 {name:"CUT",visible:true},{name:"HIDDEN",visible:false},
]);
assert.deepEqual(parsed.skipped,[]);
const cut=parsed.object.children[0];
assert(cut);
const linework=cut.children.filter(node=>node.isLineSegments);
assert.equal(linework.length,1,"one batched line object per layer");
assert((linework[0]?.geometry.getAttribute("position").count??0)>8,
 "bulge must be tessellated into an arc, not a straight chord");
assert.equal(linework[0]?.material.color.getHex(),0x253b53,
 "ACI 7 must be dark on white paper");
assert(cut.children.some(node=>node.isSprite),"TEXT should render glyphs");
const hidden=parsed.object.children[1];
assert(hidden&&!hidden.visible);

// Nested inserts resolve after both BLOCK definitions; zero-layer children
// inherit the insertion layer and the base point is transformed correctly.
const nestedDxf=[
 "0","SECTION","2","BLOCKS",
 "0","BLOCK","2","PIN","10","5","20","0",
 "0","LINE","8","0","10","5","20","0","11","15","21","0",
 "0","ENDBLK",
 "0","BLOCK","2","UNIT","10","0","20","0",
 "0","INSERT","2","PIN","8","0","10","0","20","0",
 "0","ENDBLK","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","INSERT","2","UNIT","8","ASSEMBLY","10","100","20","50",
 "41","2","42","1","50","90",
 "0","ENDSEC","0","EOF",
].join("\n");
const nested=parseDxf(nestedDxf,THREE);
assert.equal(nested.skipped.length,0);
assert.deepEqual(nested.layers,[{name:"ASSEMBLY",visible:true}]);
const nestedPos=nested.object.children[0]?.children[0]?.geometry.getAttribute("position").array;
assert(nestedPos);
assert.deepEqual(Array.from(nestedPos).map(n=>Math.round(n*100)/100),
 [100,50,0,100,70,0],"INSERT must compose block base, parent scale and rotation");

// Complex shapes are represented as their geometry, not placeholder crosses.
const ellipseDxf=[
 "0","SECTION","2","ENTITIES",
 "0","ELLIPSE","8","CURVES","10","0","20","0","11","20","21","0",
 "40","0.5","41","0","42",String(Math.PI),
 "0","ARC","8","CURVES","10","0","20","0","40","10","50","270","51","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const curves=parseDxf(ellipseDxf,THREE);
assert.deepEqual(curves.skipped,[]);
const curvePos=curves.object.children[0]?.children[0]?.geometry.getAttribute("position").array;
assert(curvePos&&curvePos.length>100);
assert(Math.max(...Array.from(curvePos).filter((_,i)=>i%3===1))>9.8,
 "ELLIPSE must preserve its minor radius");

// Reject a cyclic INSERT deterministically rather than hanging a tab.
const cyclicDxf=[
 "0","SECTION","2","BLOCKS",
 "0","BLOCK","2","LOOP","10","0","20","0",
 "0","INSERT","2","LOOP","10","0","20","0",
 "0","ENDBLK","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","INSERT","2","LOOP","10","0","20","0",
 "0","ENDSEC","0","EOF",
].join("\n");
assert(parseDxf(cyclicDxf,THREE).skipped.some(type=>type.includes("循环")));

// Snap is based on document coordinates and works independently of renderer
// resolution, screen pixel density and zoom.
const snapText=readFileSync(new URL("../src/features/modelViewer/snap2d.ts",import.meta.url),"utf8");
const snapCompiled=await transform(snapText,{loader:"ts",format:"esm",target:"es2022"});
const {createDrawingSnapIndex}=await import("data:text/javascript;base64,"+Buffer.from(snapCompiled.code).toString("base64"));
const index=createDrawingSnapIndex([
 {x1:0,y1:0,x2:10,y2:0},
 {x1:100,y1:10,x2:200,y2:10},
]);
assert.equal(index.segmentCount,2);
assert.deepEqual(index.find(.1,.12,.5)?.kind,"endpoint");
assert.deepEqual(index.find(5,.1,.5)?.kind,"midpoint");
assert.deepEqual(index.find(7,.1,.5)?.kind,"nearest");
assert.equal(index.find(70,70,.5),null);
assert.equal(createDrawingSnapIndex([]).find(0,0,1),null);

console.log("CAD regression passed: DXF units/layers/bulges/glyphs/batching, nested INSERT/ELLIPSE, circular references and drawing snaps");
