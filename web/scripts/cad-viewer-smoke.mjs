// Run on the remote target only: node web/scripts/cad-viewer-smoke.mjs
// DXF model-space regression: layer metadata, units, batched lines,
// polyline bulges and annotation glyphs.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {build,transform} from "esbuild";
import * as THREE from "three";

// Bundle the parser with its pure NURBS evaluator. The Three dependency is
// type-only and is erased; this remains a remote-only headless regression.
const parsedBundle=await build({
 entryPoints:[fileURLToPath(new URL("../src/features/modelViewer/dxf.ts",import.meta.url))],
 bundle:true,write:false,format:"esm",platform:"node",target:"es2022",logLevel:"silent",
});
const {parseDxf}=await import("data:text/javascript;base64,"+Buffer.from(parsedBundle.outputFiles[0].text).toString("base64"));

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

// Rational quadratic NURBS reproduces a quarter-circle (not the simple
// quadratic Bezier through these same controls).
const splineModule=readFileSync(new URL("../src/features/modelViewer/nurbs2d.ts",import.meta.url),"utf8");
const splineJs=await transform(splineModule,{loader:"ts",format:"esm",target:"es2022"});
const {sampleSpline}=await import("data:text/javascript;base64,"+Buffer.from(splineJs.code).toString("base64"));
const quarter=sampleSpline({
 degree:2,controls:[{x:1,y:0},{x:1,y:1},{x:0,y:1}],
 knots:[0,0,0,1,1,1],weights:[1,Math.SQRT1_2,1],
});
assert.equal(quarter.error,undefined);
assert(quarter.points.length>=64);
assert(Math.hypot(quarter.points[32].x,quarter.points[32].y)>0.9999);
assert(Math.hypot(quarter.points[32].x,quarter.points[32].y)<1.0001);
assert(sampleSpline({
 degree:2,controls:[{x:0,y:0},{x:1,y:1},{x:2,y:2}],
 knots:[0,0,2,1,1,1],weights:[],
}).error.includes("non-monotonic"));
assert(sampleSpline({
 degree:2,
 controls:[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:10,y:0},{x:11,y:0},{x:12,y:0}],
 knots:[0,0,0,.5,.5,.5,1,1,1],weights:[],
}).error.includes("discontinuous"),"must not draw a false bridge between disjoint NURBS runs");

// The dimension representation BLOCK is drawn in its native coordinates,
// not offset by the dimension definition point (DXF group 10).
const engineeringDxf=[
 "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
 "0","LAYER","2","DIM","62","7","70","0",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","BLOCKS",
 "0","BLOCK","2","*D1","10","0","20","0",
 "0","LINE","8","0","62","0","10","10","20","20","11","30","21","20",
 "0","ENDBLK","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","DIMENSION","8","DIM","2","*D1","10","999","20","999",
 "0","LINE","8","DIM","62","1","10","0","20","0","11","1","21","0",
 "0","LINE","8","DIM","420","255","10","0","20","2","11","1","21","2",
 "0","SPLINE","8","DIM","71","2","72","6","73","3",
 "40","0","40","0","40","0","40","1","40","1","40","1",
 "41","1","41",String(Math.SQRT1_2),"41","1",
 "10","1","20","0","10","1","20","1","10","0","20","1",
 "0","ENDSEC","0","EOF",
].join("\n");
const engineering=parseDxf(engineeringDxf,THREE);
assert.deepEqual(engineering.skipped,[]);
const dimLayer=engineering.object.children.find(layer=>layer.name==="DIM");
assert(dimLayer);
const wires=dimLayer.children.filter(node=>node.isLineSegments);
assert.equal(wires.length,3,"ACI red, TrueColor blue and BYBLOCK layer colors must be distinct");
const materialColors=wires.map(w=>w.material.color.getHex()).sort((a,b)=>a-b);
assert.deepEqual(materialColors,[0x0000ff,0x253b53,0xc72e32].sort((a,b)=>a-b));
const allCoords=wires.flatMap(w=>Array.from(w.geometry.getAttribute("position").array));
assert(allCoords.includes(10)&&allCoords.includes(30));
assert(!allCoords.includes(999),"dimension definition point must not displace graphics");
const splineSegments=wires.find(w=>w.material.color.getHex()===0x253b53);
assert(splineSegments.geometry.getAttribute("position").count>64);
const missing=parseDxf([
 "0","SECTION","2","ENTITIES","0","DIMENSION","2","*MISSING",
 "0","ENDSEC","0","EOF",
].join("\n"),THREE);
assert(missing.skipped.some(value=>value.startsWith("DIMENSION")));

// Legacy POLYLINE/VERTEX runs must remain separate across BLOCK definitions
// and model-space entities (old global polyline accumulator corrupted them).
const legacy=[
 "0","SECTION","2","BLOCKS",
 "0","BLOCK","2","POLYBLOCK","10","0","20","0",
 "0","POLYLINE","8","0","70","0",
 "0","VERTEX","10","1","20","1",
 "0","VERTEX","10","2","20","1",
 "0","SEQEND","0","ENDBLK","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","POLYLINE","8","MODEL","70","0",
 "0","VERTEX","10","10","20","10",
 "0","VERTEX","10","15","20","10",
 "0","SEQEND",
 "0","INSERT","2","POLYBLOCK","8","COMP","10","100","20","100",
 "0","ENDSEC","0","EOF",
].join("\n");
const legacyResult=parseDxf(legacy,THREE);
assert.deepEqual(legacyResult.skipped,[]);
const legacyModels=new Map(legacyResult.object.children.map(group=>[
 group.name,group.children[0]?.geometry.getAttribute("position").array,
]));
assert.deepEqual(Array.from(legacyModels.get("MODEL")),[10,10,0,15,10,0]);
assert.deepEqual(Array.from(legacyModels.get("COMP")),[101,101,0,102,101,0]);

// Hostile finite-but-extreme angles must not cause an unbounded 360-degree
// increment loop (nor millions of discrete arc segments).
const hostile=parseDxf([
 "0","SECTION","2","ENTITIES",
 "0","ARC","10","0","20","0","40","10","50","1000000000","51","-1000000000",
 "0","ELLIPSE","10","0","20","0","11","10","21","0","40","0.5",
 "41","1000000000","42","-1000000000",
 "0","ENDSEC","0","EOF",
].join("\n"),THREE);
assert(hostile.object.children[0]?.children[0]?.geometry.getAttribute("position").count<=768);

// HATCH is a real triangulated surface with an unpainted interior hole. A
// translucent bounding rectangle would fail both its area and hole tests.
const hatchFixture=[
 "0","SECTION","2","ENTITIES",
 "0","HATCH","8","CUT","70","1","75","0","91","2",
 "92","2","72","0","73","1","93","4",
 "10","0","20","0","10","10","20","0",
 "10","10","20","10","10","0","20","10","97","0",
 "92","2","72","0","73","1","93","4",
 "10","3","20","3","10","7","20","3",
 "10","7","20","7","10","3","20","7","97","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const hatch=parseDxf(hatchFixture,THREE);
assert.deepEqual(hatch.skipped,[]);
const hatchMeshes=hatch.object.children[0]?.children.filter(node=>node.isMesh);
assert.equal(hatchMeshes?.length,1);
const positions=hatchMeshes[0].geometry.getAttribute("position");
let filledArea=0;
for(let i=0;i+2<positions.count;i+=3){
 const a=positions.array,b=i*3;
 const x1=a[b],y1=a[b+1],x2=a[b+3],y2=a[b+4],x3=a[b+6],y3=a[b+7];
 filledArea+=Math.abs((x2-x1)*(y3-y1)-(y2-y1)*(x3-x1))/2;
}
assert(Math.abs(filledArea-84)<.001,"hole must remain unfilled");
const patterned=parseDxf(hatchFixture.replace("70\n1\n75\n0","70\n0\n75\n0"),THREE);
assert(patterned.skipped.some(item=>item.startsWith("HATCH:")));

// Group 410 separates named paper-space drawings. Paper-only group 67 goes
// to a clearly named fallback layout instead of polluting Model Space.
const layoutFixture=[
 "0","SECTION","2","ENTITIES",
 "0","LINE","8","M","410","Model","10","0","20","0","11","2","21","0",
 "0","LINE","8","P","410","A1 SHEET","67","1","10","100","20","100","11","120","21","100",
 "0","LINE","8","Q","67","1","10","500","20","500","11","501","21","500",
 "0","ENDSEC","0","EOF",
].join("\n");
const modelLayout=parseDxf(layoutFixture,THREE);
assert.deepEqual(modelLayout.layouts,["Model","A1 SHEET","Paper Space"]);
assert.deepEqual(modelLayout.layers.map(l=>l.name),["M"]);
const sheetLayout=parseDxf(layoutFixture,THREE,"A1 SHEET");
assert.deepEqual(sheetLayout.layers.map(l=>l.name),["P"]);
const fallbackLayout=parseDxf(layoutFixture,THREE,"Paper Space");
assert.deepEqual(fallbackLayout.layers.map(l=>l.name),["Q"]);

console.log("CAD regression passed: DXF geometry, nested blocks, dimension graphics, rational NURBS, ACI/TrueColor and 2D snaps");
