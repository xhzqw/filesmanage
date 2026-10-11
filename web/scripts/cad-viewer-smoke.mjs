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
console.log("CAD DXF smoke passed: ACI, units, layers, bulges, glyphs and batching");
