// Run on the remote target only: node web/scripts/cad-viewer-smoke.mjs
// DXF model-space regression: layer metadata, units, batched lines,
// polyline bulges and annotation glyphs.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {build,transform} from "esbuild";
import * as THREE from "three";

// The screen-space XY ruler occupies the bottom/left of the CAD stage.
// A separately-positioned instruction pill used to sit behind it, producing
// a cropped white blob in the lower-left corner of the user's drawing.
const viewerPage=readFileSync(new URL("../src/pages/ModelViewer.tsx",import.meta.url),"utf8");
const viewerCss=readFileSync(new URL("../src/features/modelViewer/viewer.css",import.meta.url),"utf8");
assert(!viewerPage.includes('className="cad-hint"'),
 "CAD instructions must not be rendered behind the XY ruler");
assert(!viewerCss.includes(".cad-hint{"),
 "CAD must not retain the bottom-anchored white instruction pill");
assert(viewerPage.includes('aria-label="工程视图工具"'),
 "short in-toolbar action labels must remain accessible");
assert(!viewerPage.includes("长度基于原始 XY 坐标"),
 "persistent geometry explanation must not crowd the engineering workbench");
assert(!viewerPage.includes("兼容性提示：{skipped.join"),
 "long compatibility lists must not remain permanently expanded");
assert(viewerPage.includes("aria-expanded={showCompatibility}")&&viewerPage.includes("setShowCompatibility("),
 "compatibility diagnostics must remain available on demand");

// The actual DWG support class must be checked before the client POSTs.
// Regression: a 400 on /derivative is never a normal preview-loading step.
const dispositionBundle=await build({
 entryPoints:[fileURLToPath(new URL("../src/features/modelViewer/derivativePolicy.ts",import.meta.url))],
 bundle:true,write:false,format:"esm",platform:"node",target:"es2022",logLevel:"silent",
});
const {cadDerivativeDisposition}=await import("data:text/javascript;base64,"+
 Buffer.from(dispositionBundle.outputFiles[0].text).toString("base64"));
assert.equal(cadDerivativeDisposition({found:false,class:"licensed"}),"unsupported");
assert.equal(cadDerivativeDisposition({found:false,class:"unverified"}),"unsupported");
assert.equal(cadDerivativeDisposition({found:false,class:""}),"unsupported");
assert.equal(cadDerivativeDisposition({found:false,class:"native"}),"request");
assert.equal(cadDerivativeDisposition({found:false,class:"converted"}),"request");
assert.equal(cadDerivativeDisposition({found:false,class:"invalid"}),"unsupported");
assert.equal(cadDerivativeDisposition({found:true,class:"native"}),"existing");
assert.equal(cadDerivativeDisposition({found:true,class:"licensed"}),"unsupported");
assert.equal(cadDerivativeDisposition({found:true,class:"converted",state:"failed"}),"existing");
assert.equal(cadDerivativeDisposition({found:true,class:"converted",state:"failed"},true),"request");
assert.equal(cadDerivativeDisposition({found:true,class:"converted",state:"ready"},true),"existing");

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
const colorFixture=[
 "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
 "0","LAYER","2","WHITE_LAYER","62","7","420","16777215",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","LINE","8","WHITE_LAYER","10","0","20","0","11","100","21","0",
 "0","LINE","8","TRUE_WHITE","420","16777215","10","0","20","10","11","100","21","10",
 "0","LINE","8","CYAN","420","65535","10","0","20","20","11","100","21","20",
 "0","LINE","8","DARK","420","2245734","10","0","20","30","11","100","21","30",
 "0","ENDSEC","0","EOF",
].join("\n");
const contrasted=parseDxf(colorFixture,THREE);
const inkColors=new Map(contrasted.object.children.map(layer=>[
 layer.name,layer.children.find(child=>child.isLineSegments)?.material.color.getHex(),
]));
assert.equal(inkColors.get("WHITE_LAYER"),0x172a3b,"white layer TrueColor must be dark ink on white paper");
assert.equal(inkColors.get("TRUE_WHITE"),0x172a3b,"explicit white entity cannot disappear on white paper");
assert.equal(inkColors.get("DARK"),2245734,"dark CAD ink should retain its own actual hue");
assert.notEqual(inkColors.get("CYAN"),65535,"bright cyan must gain contrast without becoming invisible");
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
assert.equal(index.pick(5,.12,.5)?.length,10,"line pick exposes full source-coordinate length");
assert.equal(index.pick(150,10.12,.5)?.length,100);
assert.equal(index.pick(70,70,.5),null,"clicking empty paper cannot fabricate a dimension");
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

// Missing anonymous DIMENSION blocks must not erase ordinary engineering
// dimensions. The fallback is explicitly approximate, restricted to complete
// rotated/aligned linear definitions and supported DIMSTYLE settings.
const linearDimension=[
 "0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC",
 "0","SECTION","2","TABLES","0","TABLE","2","DIMSTYLE",
 "0","DIMSTYLE","2","CUSTOM","40","1","41","2","42","0.5",
 "44","1","140","3","147","0.5","271","1","144","1",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","DIMENSION","8","DIM","2","*MISSING","3","CUSTOM",
 "70","0","10","0","20","8",
 "13","0","23","0","14","20","24","0","50","0","1","L=<>",
 "0","ENDSEC","0","EOF",
].join("\n");
const dimensionFallback=parseDxf(linearDimension,THREE);
assert(dimensionFallback.skipped.some(message=>message.includes("近似重建")));
const dimensionModule=await transform(readFileSync(new URL("../src/features/modelViewer/dimension2d.ts",import.meta.url),"utf8"),
 {loader:"ts",format:"esm",target:"es2022"});
const {buildDimensionFallback,parseDimensionStyle}=await import("data:text/javascript;base64,"+
 Buffer.from(dimensionModule.code).toString("base64"));
const dimStyle=parseDimensionStyle([{code:40,value:"1"},{code:140,value:"3"},
 {code:271,value:"1"},{code:147,value:"0.5"},{code:144,value:"1"}]);
const dimensionValues=[
 {code:70,value:"0"},{code:10,value:"0"},{code:20,value:"8"},
 {code:13,value:"0"},{code:23,value:"0"},{code:14,value:"20"},
 {code:24,value:"0"},{code:50,value:"0"},{code:1,value:"L=<>"}
];
const dimensionGeometry=buildDimensionFallback(dimensionValues,dimStyle);
assert(!dimensionGeometry.error);
assert.equal(dimensionGeometry.label.text,"L=20.0");
assert.equal(dimensionGeometry.label.height,3);
assert.equal(dimensionGeometry.measured,20);
assert.equal(buildDimensionFallback(dimensionValues.map(v=>v.code===1?{...v,value:" "}:v),
 dimStyle).label,null,"a single space suppresses dimension text");
assert.equal(buildDimensionFallback(dimensionValues.map(v=>v.code===70?{...v,value:"3"}:v),
 dimStyle).error.includes("无安全回退"),true);
const dimensionLayer=dimensionFallback.object.children.find(node=>node.name==="DIM");
assert(dimensionLayer);
const dimensionWires=dimensionLayer.children.find(node=>node.isLineSegments);
assert(dimensionWires.geometry.getAttribute("position").count>=12,
 "fallback draws dimension line, witness lines, and arrow outlines");
const dimensionSprite=dimensionLayer.children.find(node=>node.isSprite);
assert(dimensionSprite&&dimensionSprite.scale.y>0);
const measuredNodes=Array.from(dimensionWires.geometry.getAttribute("position").array);
assert(measuredNodes.includes(20)&&measuredNodes.includes(8),
 "dimension line uses user-supplied coordinates and offset");
const alignedFallback=parseDxf(linearDimension
 .replace("70\n0\n10\n0\n20\n8","70\n1\n10\n0\n20\n8")
 .replace("50\n0\n1\nL=<>","1\n<>"),THREE);
assert(alignedFallback.skipped.some(message=>message.includes("近似重建")));
const disallowed=parseDxf(linearDimension.replace("70\n0\n10\n0\n20\n8","70\n2\n10\n0\n20\n8"),THREE);
assert(disallowed.skipped.some(message=>message.includes("角度")));
assert.equal(disallowed.object.children.length,0);
const toleranced=parseDxf(linearDimension.replace("271\n1","71\n1\n271\n1"),THREE);
assert(toleranced.skipped.some(message=>message.includes("公差")));
assert.equal(toleranced.object.children.length,0);
const missingWitnessPoint=parseDxf(linearDimension.replace("14\n20\n24\n0","14\n20"),THREE);
assert(missingWitnessPoint.skipped.some(message=>message.includes("定义点不足")));
// Existing representation graphics remain authoritative: no fallback line
// should be added or graphics displaced when the anonymous block is valid.
const overriddenGraphic=parseDxf(engineeringDxf.replace("10\n999\n20\n999",
 "1\nOVERRIDE\n10\n999\n20\n999"),THREE);
assert(overriddenGraphic.skipped.some(message=>message.includes("覆盖")));
assert(overriddenGraphic.object.children.some(node=>node.name==="DIM"));

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

// Mechanical SOLID arrowheads and title-block fills must be filled geometry.
const solidFixture=[
 "0","SECTION","2","ENTITIES",
 "0","SOLID","8","FILLS","10","0","20","0","11","6","21","0",
 "12","0","22","4","13","6","23","4",
 "0","SOLID","8","FILLS","10","10","20","0","11","14","21","0","12","12","22","3",
 "0","SOLID","8","FILLS","10","16","20","0","11","20","21","0",
 "12","18","22","3","13","16","23","0",
 "0","SOLID","8","FILLS","10","24","20","0","11","28","21","0",
 "12","24","22","0","13","24","23","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const solids=parseDxf(solidFixture,THREE);
assert.deepEqual(solids.skipped,[],"valid SOLIDs must not be silently dropped");
const meshes=solids.object.children.flatMap(group=>group.children.filter(n=>n.isMesh&&n.name==="SOLID"));
assert.equal(meshes.length,3);
let solidArea=0;
for(const mesh of meshes){
 const positions=mesh.geometry.getAttribute("position");
 for(let i=0;i+2<positions.count;i+=3){
  const a=positions.array,j=i*3;
  solidArea+=Math.abs((a[j+3]-a[j])*(a[j+7]-a[j+1])-
   (a[j+4]-a[j+1])*(a[j+6]-a[j]))/2;
 }
}
assert(Math.abs(solidArea-36)<.001,"quadrilateral and both triangle encodings must retain filled area");

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

// Hatch line families use DXF angle/base/offset and are clipped to actual
// polygon rings. Holes must remain white in a dense cross-section pattern.
const patternDxf=[
 "0","SECTION","2","ENTITIES",
 "0","HATCH","8","PATTERN","70","0","75","0","91","2",
 "92","2","72","0","73","1","93","4",
 "10","0","20","0","10","10","20","0","10","10","20","10","10","0","20","10","97","0",
 "92","2","72","0","73","1","93","4",
 "10","3","20","3","10","7","20","3","10","7","20","7","10","3","20","7","97","0",
 "78","1","53","0","43","0","44","0","45","0","46","2","79","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const patternedHatch=parseDxf(patternDxf,THREE);
assert.deepEqual(patternedHatch.skipped,[]);
const strokes=Array.from(patternedHatch.object.children[0].children[0].geometry.getAttribute("position").array);
assert(strokes.length>=30&&strokes.length<400);
for(let j=0;j<strokes.length;j+=6){
 const midX=(strokes[j]+strokes[j+3])/2,midY=(strokes[j+1]+strokes[j+4])/2;
 assert(midX<3||midX>7||midY<3||midY>7,"pattern may not paint inside hole");
}
// Negative offsets must produce the same bounded families, not no lines.
const negativeOffset=parseDxf(patternDxf.replace("46\n2\n79","46\n-2\n79"),THREE);
assert.deepEqual(negativeOffset.skipped,[]);
assert(negativeOffset.object.children[0].children[0].geometry.getAttribute("position").count>0);
const dashed=parseDxf(patternDxf.replace("79\n0","79\n2\n49\n2\n49\n-1"),THREE);
assert.deepEqual(dashed.skipped,[]);
assert(dashed.object.children[0].children[0].geometry.getAttribute("position").count>0);

// Style records affect TEXT sprite width and rotation. SHX remains an honest
// fallback warning, and common AutoCAD symbolic escapes become Unicode.
const textDxf=[
 "0","SECTION","2","TABLES","0","TABLE","2","STYLE",
 "0","STYLE","2","ANNOTATION","3","romans.shx","41","0.8",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","TEXT","8","NOTES","7","ANNOTATION","10","10","20","20",
 "40","3","41","1.5","50","30","1","%%c25 %%d %%p",
 "0","VIEWPORT","8","FRAME","410","A1","67","1","69","2",
 "10","100","20","50","40","40","41","20",
 "0","ENDSEC","0","EOF",
].join("\n");
const textResult=parseDxf(textDxf,THREE);
assert(textResult.skipped.some(value=>value.includes("SHX")));
const note=textResult.object.children[0].children.find(item=>item.isSprite);
assert(note);
assert(note.scale.x>4&&note.material.rotation>0.5);
const paperResult=parseDxf(textDxf,THREE,"A1");
assert(paperResult.skipped.some(value=>value.includes("VIEWPORT")));
const frame=paperResult.object.children[0].children[0].geometry.getAttribute("position").array;
assert.deepEqual([frame[0],frame[1],frame[3],frame[4]],[80,40,120,40]);
const cadTextJs=await transform(readFileSync(new URL("../src/features/modelViewer/cadText2d.ts",import.meta.url),"utf8"),
 {loader:"ts",format:"esm",target:"es2022"});
const {decodeCadText}=await import("data:text/javascript;base64,"+Buffer.from(cadTextJs.code).toString("base64"));
assert.equal(decodeCadText("%%c25 %%d %%p"),"Ø25 ° ±");
assert.equal(decodeCadText("%%c2.00"),"Ø2.00");
assert.equal(decodeCadText(String.raw`\U+23002.00`),"Ø2.00");
assert.equal(decodeCadText("%%p0.05 %%d"),"±0.05 °");
assert.equal(decodeCadText("A\\PB\\U+00B0"),"A\nB°");
const {cadFontFamily}=await import("data:text/javascript;base64,"+Buffer.from(cadTextJs.code).toString("base64"));
const comicFont=cadFontFamily({fontFile:"C:\\Windows\\Fonts\\comic.ttf",widthFactor:1,fixedHeight:0},"Comic Sans MS");
const arialFont=cadFontFamily({fontFile:"arial.ttf",widthFactor:1,fixedHeight:0},"ARIAL");
assert.match(comicFont.family,/Comic Sans MS/);
assert.match(comicFont.family,/Z003/,"non-Windows must not silently substitute Arial for Comic Sans");
assert(!comicFont.family.includes("Arial"),"handwriting font fallback must remain visually distinguishable");
assert.match(arialFont.family,/Arial/);
assert(!arialFont.family.includes("Comic"));
assert(cadFontFamily({fontFile:"romans.shx",widthFactor:1,fixedHeight:0},"ANNOTATION").approximate);
assert(cadFontFamily({fontFile:"uninstalled-family.ttf",widthFactor:1,fixedHeight:0},"Custom").approximate);
const fontFixture=[
 "0","SECTION","2","TABLES","0","TABLE","2","STYLE",
 "0","STYLE","2","Comic Sans MS","3","comic.ttf","41","1",
 "0","STYLE","2","ARIAL","3","arial.ttf","41","1",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","TEXT","8","FONTS","7","Comic Sans MS","10","0","20","0","40","4","1","ABCDEFG 123",
 "0","TEXT","8","FONTS","7","ARIAL","10","0","20","10","40","4","1","ABCDEFG 123",
 "0","ENDSEC","0","EOF",
].join("\n");
const comparedFonts=parseDxf(fontFixture,THREE);
const fontLabels=comparedFonts.object.children[0].children.filter(child=>child.isSprite);
assert.equal(fontLabels.length,2);
assert.notEqual(fontLabels[0].userData.cadFontFamily,fontLabels[1].userData.cadFontFamily);
assert.equal(fontLabels[0].userData.cadFontApproximate,true);
assert.equal(fontLabels[1].userData.cadFontApproximate,false);

// Rectangular paper VIEWPORTs project *model* linework at correct 2D scale.
// Paper framing and model linework retain their own layer/ACI colors.
const viewportFixture=[
 "0","SECTION","2","ENTITIES",
 "0","LINE","8","CUT","62","1","410","Model",
 "10","-20","20","10","11","60","21","10",
 "0","LINE","8","OFFSET","62","5","410","Model",
 "10","0","20","1000","11","40","21","1000",
 "0","VIEWPORT","8","FRAME","410","A1","67","1","69","2",
 "10","100","20","50","40","40","41","20",
 "12","20","22","10","45","20","51","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const projected=parseDxf(viewportFixture,THREE,"A1");
assert.deepEqual(projected.skipped,[]);
assert.deepEqual(projected.viewports,{total:1,projected:1});
assert.deepEqual(projected.layers.map(l=>l.name),["FRAME","CUT"]);
const frameLayer=projected.object.children.find(l=>l.name==="FRAME");
const cutLayer=projected.object.children.find(l=>l.name==="CUT");
assert(frameLayer&&cutLayer);
assert.equal(cutLayer.children[0].material.color.getHex(),0xc72e32);
const projectedCoords=Array.from(cutLayer.children[0].geometry.getAttribute("position").array);
assert.deepEqual(projectedCoords,[80,50,0,120,50,0],
 "model line must be clipped to rectangular paper viewport");
const rotated=parseDxf(viewportFixture
 .replace("12\n20\n22\n10","12\n0\n22\n0\n17\n20\n27\n10")
 .replace("51\n0","51\n"+Math.PI/2),THREE,"A1");
assert.deepEqual(rotated.skipped,[]);
const rotatedLine=rotated.object.children.find(l=>l.name==="CUT");
assert(rotatedLine);
const rotatedCoords=Array.from(rotatedLine.children[0].geometry.getAttribute("position").array);
assert(rotatedCoords.every(Number.isFinite));
assert(Math.abs(rotatedCoords[0]-100)<.001&&Math.abs(rotatedCoords[3]-100)<.001,
 "90 degree view twist must map horizontal model lines to vertical paper lines");
assert(rotatedCoords.every((value,index)=>index%3!==1||(value>=40&&value<=60)),
 "twisted viewport line must be clipped to paper height");
// DCS center is relative to the WCS target, not an absolute world coordinate.
const targeted=parseDxf(viewportFixture.replace("12\n20\n22\n10","12\n0\n22\n0\n17\n20\n27\n10"),THREE,"A1");
assert.deepEqual(targeted.skipped,[]);
const targetedLine=targeted.object.children.find(l=>l.name==="CUT");
assert.deepEqual(Array.from(targetedLine.children[0].geometry.getAttribute("position").array),
 [80,50,0,120,50,0]);
const incomplete=parseDxf(viewportFixture.replace("45\n20","45\n0"),THREE,"A1");
assert(incomplete.skipped.some(value=>value.includes("投影比例")));
assert.deepEqual(incomplete.viewports,{total:1,projected:0});
const tilted=parseDxf(viewportFixture.replace("51\n0","16\n0.2\n26\n0\n36\n0.98\n51\n0"),THREE,"A1");
assert(tilted.skipped.some(value=>value.includes("倾斜")));
const perspective=parseDxf(viewportFixture.replace("51\n0","90\n1\n51\n0"),THREE,"A1");
assert(perspective.skipped.some(value=>value.includes("透视")));

// Paper viewport composition must clip BOTH filled meshes and texture glyphs.
// Frozen layer handles are allowed to precede DXF layer names in TABLES.
const paperObjects=[
 "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
 "0","LAYER","5","AB","2","STEEL","62","1",
 "0","LAYER","5","CD","2","ANNO","62","7",
 "0","ENDTAB","0","ENDSEC",
 "0","SECTION","2","ENTITIES",
 "0","HATCH","8","STEEL","70","1","75","0","91","1",
 "92","2","72","0","73","1","93","4",
 "10","-10","20","-10","10","50","20","-10",
 "10","50","20","30","10","-10","20","30","97","0",
 "0","LINE","8","STEEL","10","-20","20","10","11","60","21","10",
 "0","TEXT","8","ANNO","10","-4","20","10","40","5","1","NOTE",
 "0","VIEWPORT","8","FRAME","410","PAPER","67","1","69","2",
 "10","100","20","50","40","40","41","20",
 "12","20","22","10","45","20","51","0",
 "0","ENDSEC","0","EOF",
].join("\n");
const composed=parseDxf(paperObjects,THREE,"PAPER");
assert.deepEqual(composed.skipped,[]);
assert.deepEqual(composed.layers.map(v=>v.name),["FRAME","STEEL","ANNO"]);
assert.deepEqual(composed.viewports,{total:1,projected:1});
const hatchGroup=composed.object.children.find(g=>g.name==="STEEL");
const projectedFill=hatchGroup.children.find(n=>n.name==="VIEWPORT_HATCH");
assert(projectedFill&&projectedFill.isMesh);
const coords=projectedFill.geometry.getAttribute("position").array;
let hatchArea=0;
for(let i=0;i+8<coords.length;i+=9)
 hatchArea+=Math.abs((coords[i+3]-coords[i])*(coords[i+7]-coords[i+1])-
  (coords[i+4]-coords[i+1])*(coords[i+6]-coords[i]))/2;
assert(Math.abs(hatchArea-800)<.01,"fill triangles must be clipped to 40×20 paper viewport");
const textGroup=composed.object.children.find(g=>g.name==="ANNO");
const projectedText=textGroup.children.find(n=>n.name==="VIEWPORT_TEXT");
assert(projectedText?.isMesh);
const uv=projectedText.geometry.getAttribute("uv");
assert(uv.count>=3);
assert(Array.from(uv.array).every(value=>value>=-1e-6&&value<=1+1e-6));
const textVertices=projectedText.geometry.getAttribute("position");
for(let i=0;i<textVertices.count;i++){
 assert(textVertices.getX(i)>=80-1e-5&&textVertices.getX(i)<=120+1e-5);
 assert(textVertices.getY(i)>=40-1e-5&&textVertices.getY(i)<=60+1e-5);
}
// Inject the frozen handle immediately before the VIEWPORT's view center.
const frozenDrawing=parseDxf(paperObjects.replace("12\n20\n22\n10\n45","331\nAB\n12\n20\n22\n10\n45"),
 THREE,"PAPER");
assert.deepEqual(frozenDrawing.skipped,[]);
assert.deepEqual(frozenDrawing.layers.map(v=>v.name),["FRAME","ANNO"]);
assert.deepEqual(frozenDrawing.viewports,{total:1,projected:1});
const unknownFrozen=parseDxf(paperObjects.replace("12\n20\n22\n10\n45","331\nUNKNOWN\n12\n20\n22\n10\n45"),
 THREE,"PAPER");
assert(unknownFrozen.skipped.some(value=>value.includes("冻结图层句柄")));
assert.deepEqual(unknownFrozen.viewports,{total:1,projected:0});

// Print previews size the raster sheet in millimeters without claiming
// exact CAD plot scale. Untrusted layout labels must not inject HTML.
const printCode=await transform(readFileSync(new URL("../src/features/modelViewer/printSheet.ts",import.meta.url),"utf8"),
 {loader:"ts",format:"esm",target:"es2022"});
const {printableSheetHtml}=await import("data:text/javascript;base64,"+Buffer.from(printCode.code).toString("base64"));
const samplePng="data:image/png;base64,iVBORw0KGgo=";
const a4=printableSheetHtml(samplePng,"A4","A1 <script>");
assert(a4.includes("@page{size:A4 landscape;margin:0}"));
assert(a4.includes("width:297mm;height:210mm"));
assert(a4.includes("A1 &lt;script&gt;"));
assert(!a4.includes("<script>"));
const a3=printableSheetHtml(samplePng,"A3","A2");
assert(a3.includes("width:420mm;height:297mm"));
assert(printableSheetHtml(samplePng,"A1","A1").includes("width:841mm;height:594mm"));
assert.throws(()=>printableSheetHtml("https://evil.invalid/image.png","A4","x"),/无效/);

// V3.7 plot scale is driven by DXF drawing coordinates, never an arbitrary
// WebGL viewport screenshot or fit-to-page transform.
const plotCode=await transform(readFileSync(new URL("../src/features/modelViewer/vectorSheet.ts",import.meta.url),"utf8"),
 {loader:"ts",format:"esm",target:"es2022"});
const {buildVectorSheet}=await import("data:text/javascript;base64,"+Buffer.from(plotCode.code).toString("base64"));
const paperMm=viewportFixture.replace("0\nSECTION\n2\nENTITIES",
 "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES");
const mmDrawing=parseDxf(paperMm,THREE,"A1");
assert.equal(mmDrawing.unit,"mm");
// Moving the scene for screen fit must not alter printed dimensions.
mmDrawing.object.position.set(-150,-50,0);
const vectorA4=buildVectorSheet(mmDrawing.object,{sheet:"A4",scale:1,unit:"mm",layout:"A1"});
assert.equal(vectorA4.scaleLabel,"1:1");
assert.deepEqual(vectorA4.drawingMm,[40,20]);
assert(vectorA4.svg.includes('width="297mm" height="210mm"'));
assert(vectorA4.svg.includes('x1="10" y1="190" x2="50" y2="190"')||
 vectorA4.svg.includes('x1="10" y1="200" x2="50" y2="200"'),
 "plot line coordinates should map directly to physical mm");
assert(!vectorA4.svg.includes("preserveAspectRatio"));
const vectorHalf=buildVectorSheet(mmDrawing.object,{sheet:"A4",scale:2,unit:"mm",layout:"A1"});
assert.deepEqual(vectorHalf.drawingMm,[20,10]);
assert(vectorHalf.html.includes("1:2"));
assert(vectorA4.svg.includes('stroke="#18212b"'),"high-contrast monochrome is the default CAD plot");
const colorPlot=buildVectorSheet(mmDrawing.object,{sheet:"A4",scale:1,unit:"mm",layout:"A1",colorMode:"source"});
assert(!colorPlot.svg.includes('stroke="#18212b"'),"original color mode is distinct from monochrome");
const largeSheet=buildVectorSheet(mmDrawing.object,{sheet:"A1",scale:20,unit:"mm",layout:"A1"});
assert(largeSheet.svg.includes('width="841mm" height="594mm"'));
assert(largeSheet.html.includes("@page{size:841mm 594mm"));
assert.deepEqual(largeSheet.drawingMm,[2,1]);
assert.throws(()=>buildVectorSheet(mmDrawing.object,{sheet:"A4",scale:1,unit:"unknown",layout:"A1"}),/毫米/);
assert.throws(()=>buildVectorSheet(mmDrawing.object,{sheet:"A4",scale:1,unit:"mm",layout:"Model"}),/图纸布局/);
const overflowGroup=new THREE.Group();
const printedLayer=new THREE.Group();printedLayer.userData.layer="CUT";
printedLayer.add(new THREE.LineSegments(
 new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(400,0,0)]),
 new THREE.LineBasicMaterial({color:0x253b53})));
overflowGroup.add(printedLayer);
assert.throws(()=>buildVectorSheet(overflowGroup,{sheet:"A4",scale:1,unit:"mm",layout:"A1"}),/超出/);
assert.deepEqual(buildVectorSheet(overflowGroup,{sheet:"A4",scale:2,unit:"mm",layout:"A1"}).drawingMm,[200,0]);

const modelCode=await transform(readFileSync(new URL("../src/features/modelViewer/modelPrintSheet.ts",import.meta.url),"utf8"),
 {loader:"ts",format:"esm",target:"es2022"});
const {modelPrintSheetHtml}=await import("data:text/javascript;base64,"+Buffer.from(modelCode.code).toString("base64"));
const modelInput={name:"test <script>模型.stl",versionSeq:7,sha256:"a".repeat(64),unit:"unknown",
 format:"stl",paper:"A3",metrics:{size:[40,25,60],triangles:12,vertices:36,components:1},
 views:{front:samplePng,right:samplePng,top:samplePng,iso:samplePng}};
const modelPage=modelPrintSheetHtml(modelInput);
assert(modelPage.includes("@page{size:420mm 297mm"));
assert(modelPage.includes("主视图")&&modelPage.includes("俯视图")&&modelPage.includes("等轴测"));
assert(modelPage.includes("40 × 25 × 60")&&modelPage.includes("未声明（不作为制造尺寸）"));
assert(!modelPage.includes("<script>"),"model filenames must not inject HTML");
assert.throws(()=>modelPrintSheetHtml({...modelInput,views:{...modelInput.views,front:"https://bad.invalid"}}),/无效截图/);

console.log("CAD regression passed: DXF geometry, nested blocks, dimension graphics, rational NURBS, ACI/TrueColor and 2D snaps");
