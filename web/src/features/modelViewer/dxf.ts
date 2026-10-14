// Model-space DXF renderer: readable layer colours, batched segments and labels.
//
// Two passes: the LAYER table (name + ACI colour), then the ENTITIES section.
// Supported: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE/VERTEX/SEQEND and
// TEXT/MTEXT are rendered as glyph sprites. Each layer becomes a child group,
// and layer colours come from the drawing's own ACI index — never the brand
// palette. Anything else is reported as skipped, never silently dropped.
import type * as THREE from "three";
import {sampleSpline} from "./nurbs2d";
import {parseHatchPaths} from "./hatch2d";
import {clipHatchPattern} from "./hatchPattern2d";
import {cadFontFamily,decodeCadText,type CadTextStyle} from "./cadText2d";
import {clipUvPolygon,createPaperViewport,type UvPoint,type ValidViewport} from "./paperViewport2d";
import {buildDimensionFallback,DEFAULT_DIM_STYLE,parseDimensionStyle,
 type DimensionPair,type DimensionStyle} from "./dimension2d";
import {readablePaperColor} from "./drawingPalette";

export type DxfParseResult={
 object:THREE.Group;
 layers:{name:string;visible:boolean}[];
 skipped:string[];
 unit:string;
 layouts:string[];
 layout:string;
 viewports:{total:number;projected:number};
};

// DXF ACI 7 means black on white paper (and white on dark model space).
const ACI:Record<number,number>={1:0xc72e32,2:0xa57b07,3:0x188049,4:0x087e92,5:0x235bbd,6:0x9733ad,7:0x253b53};
const UNITS:Record<number,string>={1:"in",2:"ft",3:"mi",4:"mm",5:"cm",6:"m",7:"km",8:"µin",9:"mil",10:"yd",14:"dm"};

function aciColor(code:number):number{
 const known=ACI[Math.abs(code)];
 if(known!==undefined)return known;
 // Unknown ACI indices keep a stable readable hue instead of claiming to be
 // the exact CAD colour.
 return (Math.abs(code)*4127+0x334455)&0x7f7f7f;
}

type Pair={code:number;value:string};

function pairs(text:string):Pair[]{
 const lines=text.split(/\r?\n/);
 const out:Pair[]=[];
 for(let i=0;i+1<lines.length;i+=2){
  const code=Number.parseInt((lines[i]??"").trim(),10);
  if(Number.isNaN(code))continue;
  const value=lines[i+1];
  if(value===undefined)continue;
  out.push({code,value});
 }
 return out;
}

type Point={x:number;y:number;bulge:number};
type Entity={
 type:string;
 layer:string;
 points:Point[];
 end:Point|null;
 radius:number;
 a0:number;
 a1:number;
 closed:boolean;
 height:number;
 text:string;
 blockName:string;
 scaleX:number;
 scaleY:number;
 rotation:number;
 major:Point|null;
 ratio:number;
 parameterStart:number;
 parameterEnd:number;
 degree:number;
 knots:number[];
 weights:number[];
 splineControls:Point[];
 invisible:boolean;
 colorIndex:number;
 trueColor:number|null;
 layout:string;
 paperSpace:boolean;
 raw:Pair[];
 textStyle:string;
 textWidthFactor:number;
 hAlign:number;
 vAlign:number;
 mTextAttachment:number;
 viewportId:number;
};

function emptyEntity(type:string):Entity{
 return {type,layer:"0",points:[],end:null,radius:0,a0:0,a1:360,closed:false,height:2.5,text:"",
  blockName:"",scaleX:1,scaleY:1,rotation:0,major:null,ratio:1,parameterStart:0,parameterEnd:Math.PI*2,
  degree:3,knots:[],weights:[],splineControls:[],invisible:false,colorIndex:256,trueColor:null,
  layout:"",paperSpace:false,raw:[],textStyle:"STANDARD",textWidthFactor:1,
  hAlign:0,vAlign:0,mTextAttachment:1,viewportId:0};
}

export function parseDxf(text:string,THREE:typeof import("three"),requestedLayout="Model"):DxfParseResult{
 const records=pairs(text);

 // Pass 1 — HEADER units and LAYER table.
 const layerColors=new Map<string,number>();
 const hiddenLayers=new Set<string>();
 const layerTrueColors=new Map<string,number>();
 const layerHandles=new Map<string,string>();
 const textStyles=new Map<string,CadTextStyle>();
 const dimensionStyles=new Map<string,DimensionStyle>();
 let unit="unknown";
 let section="";
 let table="";
 let pendingLayer="";
 let pendingLayerHandle="";
 let pendingStyle="";
 let dimensionStyleRecords:DimensionPair[]=[];
 let collectingDimension=false;
 const flushDimensionStyle=()=>{
  if(!collectingDimension)return;
  const name=dimensionStyleRecords.find(pair=>pair.code===2)?.value.trim().toUpperCase();
  if(name)dimensionStyles.set(name,parseDimensionStyle(dimensionStyleRecords));
  dimensionStyleRecords=[];collectingDimension=false;
 };
 let sectionPending=false;
 let tablePending=false;
 let unitPending=false;
 for(const pair of records){
  if(pair.code===0){
   flushDimensionStyle();
   if(pair.value==="SECTION"){sectionPending=true;continue;}
   if(pair.value==="ENDSEC"){section="";continue;}
   if(pair.value==="TABLE"){tablePending=true;continue;}
   if(pair.value==="LAYER"&&table==="LAYER"){pendingLayer="";pendingLayerHandle="";continue;}
   if(pair.value==="STYLE"&&table==="STYLE"){pendingStyle="";continue;}
   if(pair.value==="DIMSTYLE"&&table==="DIMSTYLE"){
    dimensionStyleRecords=[];collectingDimension=true;continue;
   }
   if(pair.value==="ENDTAB"){table="";pendingLayer="";continue;}
   continue;
  }
  if(pair.code===2&&sectionPending){section=pair.value.trim();sectionPending=false;continue;}
  if(pair.code===2&&tablePending){table=pair.value.trim();tablePending=false;continue;}
  if(collectingDimension&&section==="TABLES"&&table==="DIMSTYLE"){
   dimensionStyleRecords.push(pair);continue;
  }
  if(section==="HEADER"){
   if(pair.code===9)unitPending=pair.value.trim()==="$INSUNITS";
   else if(unitPending&&pair.code===70){unit=UNITS[Number(pair.value)]??"unknown";unitPending=false;}
  }
  if(section==="TABLES"&&table==="LAYER"){
   if(pair.code===2){
    pendingLayer=pair.value.trim();
    if(pendingLayer&&pendingLayerHandle)layerHandles.set(pendingLayerHandle,pendingLayer);
   }
   if(pair.code===5){
    pendingLayerHandle=pair.value.trim().toUpperCase();
    if(pendingLayer&&pendingLayerHandle)layerHandles.set(pendingLayerHandle,pendingLayer);
   }
   if(pair.code===62&&pendingLayer){
    const index=Number.parseInt(pair.value,10);
    layerColors.set(pendingLayer,Math.abs(index)||7);
    if(index<0)hiddenLayers.add(pendingLayer);
   }
   if(pair.code===420&&pendingLayer)layerTrueColors.set(pendingLayer,Number(pair.value)&0xffffff);
   if(pair.code===70&&pendingLayer&&(Number(pair.value)&1)!==0)hiddenLayers.add(pendingLayer);
  }
  if(section==="TABLES"&&table==="STYLE"){
   if(pair.code===2){
    pendingStyle=pair.value.trim().toUpperCase();
    if(pendingStyle&&!textStyles.has(pendingStyle))
     textStyles.set(pendingStyle,{fontFile:"",widthFactor:1,fixedHeight:0});
   }
   const style=textStyles.get(pendingStyle);
   if(style){
    if(pair.code===3)style.fontFile=pair.value.trim();
    if(pair.code===41)style.widthFactor=Number(pair.value);
    if(pair.code===40)style.fixedHeight=Number(pair.value);
   }
  }
 }
 flushDimensionStyle();
 const layerColor=(name:string)=>layerColors.get(name)??7;

 // Pass 2 — entities.
 const root=new THREE.Group();
 root.name="dxf";
 const layerGroups=new Map<string,THREE.Group>();
 const segmentBuffers=new Map<string,number[]>();
 const layerOrder:string[]=[];
 const skipped=new Set<string>();
 type Affine={a:number;b:number;c:number;d:number;x:number;y:number};
 const identity:Affine={a:1,b:0,c:0,d:1,x:0,y:0};
 const multiply=(outer:Affine,inner:Affine):Affine=>({
  a:outer.a*inner.a+outer.c*inner.b,
  b:outer.b*inner.a+outer.d*inner.b,
  c:outer.a*inner.c+outer.c*inner.d,
  d:outer.b*inner.c+outer.d*inner.d,
  x:outer.a*inner.x+outer.c*inner.y+outer.x,
  y:outer.b*inner.x+outer.d*inner.y+outer.y,
 });
 const transformed=(x:number,y:number)=>({
  x:activeTransform.a*x+activeTransform.c*y+activeTransform.x,
  y:activeTransform.b*x+activeTransform.d*y+activeTransform.y,
 });
 const blocks=new Map<string,{base:Point;items:Entity[]}>();
 type SourceStroke={x1:number;y1:number;x2:number;y2:number;layer:string;color:number};
 type SourceFill={layer:string;color:number;opacity:number;triangles:{x:number;y:number}[]};
 type SourceLabel={layer:string;color:number;opacity:number;center:{x:number;y:number};
  width:number;height:number;rotation:number;image:HTMLCanvasElement};
 type ModelContents={strokes:SourceStroke[];fills:SourceFill[];labels:SourceLabel[]};
 let modelContents:ModelContents|null=null;
 let modelWarning=false;
 let modelFillVertices=0;
 const getModelContents=():ModelContents=>{
  if(modelContents)return modelContents;
  modelContents={strokes:[],fills:[],labels:[]};
  // Paper-space projection is opt-in, bounded and performed once per parse.
  // A second full DXF parse is intentionally refused for enormous documents.
  if(text.length>12_000_000||records.length>250000){
   skipped.add("VIEWPORT: 文件过大，未投影模型空间");
   return modelContents;
  }
  let source:DxfParseResult|null=null;
  try{
   source=parseDxf(text,THREE,"Model");
   if(source.skipped.length)modelWarning=true;
   source.object.traverse(node=>{
    const parent=node.parent as THREE.Group|null;
    const layer=parent?.userData.layer;
    if(typeof layer!=="string"||parent?.visible===false)return;
    const lines=node as THREE.LineSegments;
    if(lines.isLineSegments){
     const positions=lines.geometry.getAttribute("position");
     if(!positions)return;
     if(modelContents!.strokes.length+Math.floor(positions.count/2)>180000)
      throw new Error("model geometry budget");
     const material=lines.material as THREE.LineBasicMaterial;
     const color=material.color?.getHex()??aciColor(7);
     for(let k=0;k+1<positions.count;k+=2){
      modelContents!.strokes.push({
       x1:positions.getX(k),y1:positions.getY(k),
       x2:positions.getX(k+1),y2:positions.getY(k+1),layer,color,
      });
     }
     return;
    }
    const mesh=node as THREE.Mesh;
    if(mesh.isMesh&&(mesh.name==="HATCH"||mesh.name==="SOLID")){
     const position=mesh.geometry.getAttribute("position");
     if(!position)return;
     const triangles:SourceFill["triangles"]=[];
     if(position.count>20000||modelFillVertices+position.count>45000||
        modelContents!.fills.length>=1200)
      throw new Error("model geometry budget");
     modelFillVertices+=position.count;
     for(let k=0;k<position.count;k++)
      triangles.push({x:position.getX(k),y:position.getY(k)});
     const material=mesh.material as THREE.MeshBasicMaterial;
     modelContents!.fills.push({layer,color:material.color.getHex(),opacity:material.opacity,triangles});
     return;
    }
    const sprite=node as THREE.Sprite;
    if(sprite.isSprite){
     const material=sprite.material as THREE.SpriteMaterial;
     const image=material.map?.image;
     if(!image||typeof image!=="object"||!("getContext" in image)||
        modelContents!.labels.length>=400){
      modelWarning=true;return;
     }
     modelContents!.labels.push({layer,color:material.color.getHex(),opacity:material.opacity,
      center:{x:sprite.position.x,y:sprite.position.y},width:sprite.scale.x,
      height:sprite.scale.y,rotation:material.rotation,image:image as HTMLCanvasElement});
     return;
    }
    if(mesh.isMesh)modelWarning=true;
   });
  }catch(error){
   if(!(error instanceof Error&&error.message==="model geometry budget"))
    skipped.add("VIEWPORT: 模型空间解析失败");
   else skipped.add("VIEWPORT: 模型实体超出投影预算");
   modelContents={strokes:[],fills:[],labels:[]};
  }finally{
   source?.object.traverse(node=>{
    const item=node as THREE.Mesh|THREE.LineSegments|THREE.Sprite;
    if(!("material" in item))return;
    if("geometry" in item)item.geometry?.dispose();
    const materials=Array.isArray(item.material)?item.material:[item.material];
    for(const material of materials){
     if(!material)continue;
     const sprite=material as THREE.SpriteMaterial;
     sprite.map?.dispose();
     material.dispose();
    }
   });
  }
  if(modelWarning)skipped.add("VIEWPORT: 模型含无法精确显示的实体");
  return modelContents;
 };
 let activeTransform:Affine=identity;
 let inheritedLayer="0";
 let inheritedColor:number|null=null;
 let currentColor=aciColor(7);
 const MAX_SEGMENTS=700000;
 let emittedSegments=0;
 let visitedEntities=0;
 const MAX_ENTITIES=200000;
 let viewportTotal=0,viewportProjected=0;
 const blockStack=new Set<string>();
 const actualLayer=(name:string)=>name==="0"?inheritedLayer:name;
 const hatchBudget=120000;
 let hatchTriangles=0;
 const resolvedLayerColor=(name:string)=>readablePaperColor(layerTrueColors.get(name)??aciColor(layerColor(name)));
 const entityColor=(e:Entity)=>{
  const layer=actualLayer(e.layer);
  if(e.trueColor!==null)return readablePaperColor(e.trueColor);
  if(e.colorIndex===0)return readablePaperColor(inheritedColor??resolvedLayerColor(layer));
  if(e.colorIndex===256)return resolvedLayerColor(layer);
  return readablePaperColor(aciColor(e.colorIndex));
 };

 const groupFor=(name:string)=>{
  let group=layerGroups.get(name);
  if(!group){
   group=new THREE.Group();
   group.name=name;
   group.userData.layer=name;
   group.visible=!hiddenLayers.has(name);
   layerGroups.set(name,group);
   layerOrder.push(name);
   root.add(group);
  }
  return group;
 };
 const line=(x1:number,y1:number,x2:number,y2:number,layer:string)=>{
  if(![x1,y1,x2,y2].every(v=>Number.isFinite(v)&&Math.abs(v)<1e12))return;
  if(emittedSegments>=MAX_SEGMENTS){skipped.add("LIMIT: 最大线段预算");return;}
  const a=transformed(x1,y1),b=transformed(x2,y2),resolved=actualLayer(layer);
  if(![a.x,a.y,b.x,b.y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e12)){
   skipped.add("GEOMETRY: 变换越界");return;
  }
  groupFor(resolved);
  // Keep geometry batched per layer AND effective entity colour.
  const key=resolved+"\u0000"+currentColor;
  let coordinates=segmentBuffers.get(key);
  if(!coordinates){coordinates=[];segmentBuffers.set(key,coordinates);}
  coordinates.push(a.x,a.y,0,b.x,b.y,0);
  emittedSegments++;
 };
 const arc=(x:number,y:number,r:number,from:number,to:number,layer:string)=>{
  if(![x,y,r,from,to].every(Number.isFinite)||r<=0)return;
  const full=Math.abs(to-from)>=360;
  const deg=full?360:((to-from)%360+360)%360||360;
  const sweep=deg*Math.PI/180;
  const divisions=Math.min(192,Math.max(24,Math.ceil(sweep*30)));
  let px=x+r*Math.cos(from*Math.PI/180),py=y+r*Math.sin(from*Math.PI/180);
  for(let i=1;i<=divisions;i++){
   const angle=(from*Math.PI/180)+sweep*i/divisions;
   const nx=x+r*Math.cos(angle),ny=y+r*Math.sin(angle);
   line(px,py,nx,ny,layer);px=nx;py=ny;
  }
 };
 const polySegment=(a:Point,b:Point,layer:string)=>{
  const theta=4*Math.atan(a.bulge);
  const tangent=Math.tan(theta/2);
  if(!Number.isFinite(theta)||Math.abs(theta)<1e-7||Math.abs(tangent)<1e-7){
   line(a.x,a.y,b.x,b.y,layer);return;
  }
  const cx=(a.x+b.x)/2-(b.y-a.y)/(2*tangent);
  const cy=(a.y+b.y)/2+(b.x-a.x)/(2*tangent);
  const radius=Math.hypot(a.x-cx,a.y-cy);
  if(!Number.isFinite(radius)||radius===0){line(a.x,a.y,b.x,b.y,layer);return;}
  const start=Math.atan2(a.y-cy,a.x-cx);
  const divisions=Math.min(128,Math.max(8,Math.ceil(Math.abs(theta)*24)));
  let previous=a;
  for(let i=1;i<=divisions;i++){
   const angle=start+theta*i/divisions;
   const next=i===divisions?b:{x:cx+radius*Math.cos(angle),y:cy+radius*Math.sin(angle),bulge:0};
   line(previous.x,previous.y,next.x,next.y,layer);
   previous=next;
  }
 };
 const label=(e:Entity)=>{
  const point=e.points[0];
  if(!point)return;
  const x=point.x,y=point.y,layer=e.layer;
  const style=textStyles.get(e.textStyle.toUpperCase());
  const h=(e.height>0?e.height:style?.fixedHeight)||2.5;
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(h)||h<=0)return;
  const content=decodeCadText(e.text);
  const rows=content.split("\n").slice(0,8);
  if(!content.trim())return;
  const canvas=document.createElement("canvas");
  const context=canvas.getContext("2d");
  if(!context){skipped.add("TEXT");return;}
  const fontSize=60;
  const font=cadFontFamily(style,e.textStyle);
  if(font.approximate)
   skipped.add("TEXT: CAD SHX/TTF 字体可能未安装，使用浏览器可用字体近似显示");
  context.font="500 "+fontSize+"px "+font.family;
  canvas.width=Math.min(4096,Math.ceil(Math.max(20,...rows.map(row=>context.measureText(row).width))+12));
  canvas.height=Math.ceil((fontSize+12)*rows.length);
  context.font="500 "+fontSize+"px "+font.family;
  context.textBaseline="top";
  const resolved=actualLayer(layer);
  context.fillStyle="#"+currentColor.toString(16).padStart(6,"0");
  rows.forEach((row,index)=>context.fillText(row,4,index*(fontSize+12)));
  const texture=new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));
  sprite.userData.cadFontFamily=font.family;
  sprite.userData.cadFontRequested=font.requested;
  sprite.userData.cadFontApproximate=font.approximate;
  const sx=Math.hypot(activeTransform.a,activeTransform.b);
  const sy=Math.hypot(activeTransform.c,activeTransform.d);
  const widthFactor=e.textWidthFactor*(style?.widthFactor??1);
  sprite.scale.set(canvas.width/fontSize*h*sx*Math.max(.05,Math.min(widthFactor,20)),
   canvas.height/fontSize*h*sy,1);
  const origin=transformed(x,y);
  const anchor=e.end&&e.type==="TEXT"&&e.hAlign!==0
   ?transformed(e.end.x,e.end.y):origin;
  // MTEXT group 71 specifies a 3x3 attachment, not TEXT justification.
  // Rotate the anchor-to-sprite-center offset with the text direction.
  const attachment=e.mTextAttachment>=1&&e.mTextAttachment<=9?e.mTextAttachment:1;
  const column=(attachment-1)%3,row=Math.floor((attachment-1)/3);
  const offsetX=e.type==="MTEXT"
   ?(column===0?sprite.scale.x/2:column===2?-sprite.scale.x/2:0)
   :(e.hAlign===1?0:e.hAlign===2?-sprite.scale.x/2:sprite.scale.x/2);
  const offsetY=e.type==="MTEXT"
   ?(row===0?-sprite.scale.y/2:row===2?sprite.scale.y/2:0)
   :(e.vAlign===2?0:e.vAlign===3?-sprite.scale.y/2:sprite.scale.y/2);
  const angle=Math.atan2(activeTransform.b,activeTransform.a)+(e.a0*Math.PI/180);
  sprite.position.set(anchor.x+offsetX*Math.cos(angle)-offsetY*Math.sin(angle),
   anchor.y+offsetX*Math.sin(angle)+offsetY*Math.cos(angle),0);
  (sprite.material as THREE.SpriteMaterial).rotation=angle;
  groupFor(resolved).add(sprite);
 };

 // SOLID's 4-point order is 10,11,13,12; 10,11,12,13 crosses itself.
 const drawSolid=(e:Entity)=>{
  const corner=(index:number)=>{
   const x=e.raw.find(pair=>pair.code===10+index)?.value;
   const y=e.raw.find(pair=>pair.code===20+index)?.value;
   if(x===undefined||y===undefined)return null;
   const point={x:Number(x),y:Number(y)};
   return Number.isFinite(point.x)&&Number.isFinite(point.y)&&
    Math.abs(point.x)<1e12&&Math.abs(point.y)<1e12?point:null;
  };
  const a=corner(0),b=corner(1),c=corner(2),d=corner(3);
  if(!a||!b||!c){skipped.add("SOLID: 顶点缺失或无效");return;}
  // Valid triangular SOLIDs may repeat ANY corner as the fourth point.
  // Preserve the CAD winding while removing repeat positions, not just 12=13.
  const ordered=d?[a,b,d,c]:[a,b,c];
  const input:typeof ordered=[];
  for(const point of ordered){
   if(!input.some(existing=>Math.hypot(point.x-existing.x,point.y-existing.y)<1e-8))
    input.push(point);
  }
  if(input.length<3)return; // A zero-area source is not a filled shape.
  const polygon=input.map(point=>{
   const p=transformed(point.x,point.y);
   return new THREE.Vector2(p.x,p.y);
  });
  if(polygon.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||
    Math.abs(p.x)>1e12||Math.abs(p.y)>1e12)){
   skipped.add("SOLID: 顶点变换越界");return;
  }
  const area=polygon.reduce((sum,a,index)=>{
   const b=polygon[(index+1)%polygon.length]!;
   return sum+a.x*b.y-b.x*a.y;
  },0)/2;
  if(Math.abs(area)<1e-9)return;
  const faces=THREE.ShapeUtils.triangulateShape(polygon,[]);
  if(!faces.length){skipped.add("SOLID: 退化或自交");return;}
  if(hatchTriangles+faces.length>hatchBudget){
   skipped.add("SOLID: 填充预算超限");return;
  }
  hatchTriangles+=faces.length;
  const coordinates:number[]=[];
  for(const face of faces)for(const index of face){
   const v=polygon[index];
   if(v)coordinates.push(v.x,v.y,-0.0001);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(coordinates,3));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
   color:currentColor,side:THREE.DoubleSide,depthWrite:false,
  }));
  mesh.name="SOLID";mesh.renderOrder=-1;
  groupFor(actualLayer(e.layer)).add(mesh);
 };

 const drawHatch=(e:Entity)=>{
  const parsed=parseHatchPaths(e.raw);
  if(parsed.error){skipped.add("HATCH: "+parsed.error);return;}
  if(!parsed.solid){
   const result=clipHatchPattern(parsed.rings,parsed.patterns);
   if(result.error){skipped.add("HATCH: "+result.error);return;}
   // Every clipping operation occurs in DXF document coordinates, before
   // parent BLOCK transforms. line() performs inheritance and batching.
   for(const stroke of result.strokes){
    line(stroke.x1,stroke.y1,stroke.x2,stroke.y2,e.layer);
   }
   return;
  }
  type Ring={points:THREE.Vector2[];area:number;parent:number;depth:number};
  const polygonArea=(p:THREE.Vector2[])=>p.reduce((sum,a,i)=>{
   const b=p[(i+1)%p.length]!;
   return sum+a.x*b.y-b.x*a.y;
  },0)/2;
  const contains=(polygon:THREE.Vector2[],q:THREE.Vector2)=>{
   let inside=false;
   for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i]!,b=polygon[j]!;
    if((a.y>q.y)!==(b.y>q.y)&&q.x<(b.x-a.x)*(q.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
   }
   return inside;
  };
  const rings:Ring[]=parsed.rings.map(points=>{
   const mapped=points.map(point=>{
    const p=transformed(point.x,point.y);
    return new THREE.Vector2(p.x,p.y);
   });
   return{points:mapped,area:Math.abs(polygonArea(mapped)),parent:-1,depth:0};
  }).sort((a,b)=>b.area-a.area);
  if(rings.some(r=>r.points.length<3||!Number.isFinite(r.area)||r.area<1e-9||
       r.points.some(p=>![p.x,p.y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e12)))){
   skipped.add("HATCH: 无效或退化的边界");return;
  }
  for(let i=0;i<rings.length;i++){
   const item=rings[i]!;
   for(let j=i-1;j>=0;j--){
    const candidate=rings[j]!;
    if(contains(candidate.points,item.points[0]!)){
     item.parent=j;item.depth=candidate.depth+1;break;
    }
   }
  }
  for(let i=0;i<rings.length;i++){
   const item=rings[i]!;
   if(item.depth%2!==0)continue;
   const holes=rings.filter(r=>r.parent===i&&r.depth%2===1).map(r=>r.points);
   const totalVerts=item.points.length+holes.reduce((sum,h)=>sum+h.length,0);
   if(totalVerts>12000){skipped.add("HATCH: 三角化顶点预算超限");return;}
   const triangles=THREE.ShapeUtils.triangulateShape(item.points,holes);
   if(!triangles.length){skipped.add("HATCH: 无法三角化边界");continue;}
   if(hatchTriangles+triangles.length>hatchBudget){
    skipped.add("HATCH: 填充三角形预算超限");break;
   }
   hatchTriangles+=triangles.length;
   const all=[...item.points,...holes.flat()];
   const coordinates:number[]=[];
   for(const face of triangles){
    for(const index of face){
     const v=all[index];
     if(v)coordinates.push(v.x,v.y,-0.0001);
    }
   }
   if(coordinates.length===0)continue;
   const geometry=new THREE.BufferGeometry();
   geometry.setAttribute("position",new THREE.Float32BufferAttribute(coordinates,3));
   const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
    color:currentColor,transparent:true,opacity:.4,side:THREE.DoubleSide,depthWrite:false,
   }));
   mesh.name="HATCH";mesh.renderOrder=-1;
   groupFor(actualLayer(e.layer)).add(mesh);
  }
 };

 // Clip projected model fills and text glyphs as real triangles with UVs.
 let composedTriangles=0;
 const projectFilled=(polygons:UvPoint[][],projection:ValidViewport,layer:string,
  color:number,opacity:number,image?:HTMLCanvasElement,z=-0.0001)=>{
  const coords:number[]=[],uvs:number[]=[];
  for(const polygon of polygons){
   const mapped=polygon.map(point=>({...projection.project(point),u:point.u,v:point.v}));
   const clipped=clipUvPolygon(mapped,projection.bounds);
   if(clipped.length<3)continue;
   if(composedTriangles+clipped.length-2>100000){
    skipped.add("VIEWPORT: 填充/文字裁切三角形预算已满");break;
   }
   composedTriangles+=clipped.length-2;
   for(let i=1;i+1<clipped.length;i++){
    for(const point of [clipped[0]!,clipped[i]!,clipped[i+1]!]){
     coords.push(point.x,point.y,z);
     uvs.push(point.u,point.v);
    }
   }
  }
  if(!coords.length)return false;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(coords,3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
  const texture=image?new THREE.CanvasTexture(image):null;
  if(texture)texture.colorSpace=THREE.SRGBColorSpace;
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
   map:texture,color,transparent:true,opacity,side:THREE.DoubleSide,
   depthWrite:false,depthTest:true,
  }));
  mesh.name=image?"VIEWPORT_TEXT":"VIEWPORT_HATCH";
  mesh.renderOrder=image?1:-1;
  groupFor(layer).add(mesh);
  return true;
 };

 const commit=(e:Entity)=>{
  if(++visitedEntities>MAX_ENTITIES||emittedSegments>=MAX_SEGMENTS){
   skipped.add("LIMIT: 图元展开预算");return;
  }
  if(e.invisible)return;
 if(e.type==="DIMENSION"){
   if(!e.blockName||!blocks.has(e.blockName)){
    const styleName=e.raw.find(pair=>pair.code===3)?.value.trim().toUpperCase()??"STANDARD";
    const style=dimensionStyles.get(styleName)??DEFAULT_DIM_STYLE;
    const outcome=buildDimensionFallback(e.raw,style);
    if("error" in outcome){
     skipped.add("DIMENSION: "+outcome.error+"（缺少表示图块）");return;
    }
    const previousColor=currentColor;
    currentColor=entityColor(e);
    for(const [a,b] of outcome.segments)line(a.x,a.y,b.x,b.y,e.layer);
    if(outcome.label){
     const value=outcome.label;
     const dimensionText=emptyEntity("TEXT");
     dimensionText.layer=e.layer;
     dimensionText.points=[{x:value.point.x,y:value.point.y,bulge:0}];
     dimensionText.text=value.text;
     dimensionText.height=value.height;
     dimensionText.a0=value.rotation;
     label(dimensionText);
    }
    currentColor=previousColor;
    skipped.add("DIMENSION: 匿名图块缺失，线性尺寸近似重建（非精确样式）");
    return;
   }
   const textOverride=e.raw.find(pair=>pair.code===1)?.value;
   if(textOverride&&textOverride!=="<>"&&textOverride!==" ")
    skipped.add("DIMENSION: 显式文字覆盖与匿名图块内容可能不一致");
   // Group 2 points to a graphical BLOCK; group 10 is its definition point,
   // not the graphical block insertion origin.
   commit({...e,type:"INSERT",points:[{x:0,y:0,bulge:0}],
    scaleX:1,scaleY:1,rotation:0});
   return;
  }
  if(e.type==="INSERT"){
   const def=blocks.get(e.blockName);
   if(!def){skipped.add("INSERT: "+(e.blockName||"未命名图块"));return;}
   if(blockStack.has(e.blockName)||blockStack.size>=8){
    skipped.add("INSERT: 循环或嵌套过深");return;
   }
   const pos=e.points[0]??{x:0,y:0,bulge:0};
   const angle=e.rotation*Math.PI/180;
   const cos=Math.cos(angle),sin=Math.sin(angle);
   const local:Affine={
    a:cos*e.scaleX,b:sin*e.scaleX,c:-sin*e.scaleY,d:cos*e.scaleY,
    x:pos.x-cos*e.scaleX*def.base.x+sin*e.scaleY*def.base.y,
    y:pos.y-sin*e.scaleX*def.base.x-cos*e.scaleY*def.base.y,
   };
   if(!Object.values(local).every(v=>Number.isFinite(v)&&Math.abs(v)<1e12)){
    skipped.add("INSERT: 非法变换");return;
   }
   const previous=activeTransform,previousLayer=inheritedLayer,previousColor=inheritedColor;
   const insertColor=entityColor(e);
   activeTransform=multiply(previous,local);
   inheritedLayer=actualLayer(e.layer);
   inheritedColor=insertColor;
   blockStack.add(e.blockName);
   try{
    for(const part of def.items){
     if(visitedEntities>=MAX_ENTITIES||emittedSegments>=MAX_SEGMENTS)break;
     commit(part);
    }
   }
   finally{
    blockStack.delete(e.blockName);
    activeTransform=previous;inheritedLayer=previousLayer;inheritedColor=previousColor;
   }
   return;
  }
  // Legacy POLYLINE/VERTEX/SEQEND is normalized per entity list before
  // rendering, preventing nested INSERTs from corrupting another polyline.
  const previousColor=currentColor;
  currentColor=entityColor(e);
  try{switch(e.type){
   case "LINE":{
    const a=e.points[0];
    const b=e.end??e.points[1];
    if(a&&b)line(a.x,a.y,b.x,b.y,e.layer);
    break;
   }
   case "CIRCLE":{
    const c=e.points[0];
    if(c&&e.radius>0)arc(c.x,c.y,e.radius,0,360,e.layer);
    break;
   }
   case "ARC":{
    const c=e.points[0];
    if(c&&e.radius>0)arc(c.x,c.y,e.radius,e.a0,e.a1,e.layer);
    break;
   }
   case "ELLIPSE":{
    const center=e.points[0],major=e.major;
    if(!center||!major||!Number.isFinite(e.ratio)||e.ratio<=0||e.ratio>1||!Number.isFinite(e.parameterStart)||!Number.isFinite(e.parameterEnd)){
     skipped.add("ELLIPSE: 无效几何");break;
    }
    const raw=e.parameterEnd-e.parameterStart;
    const sweep=Math.abs(raw)>=Math.PI*2?Math.PI*2:((raw%(Math.PI*2)+Math.PI*2)%(Math.PI*2))||Math.PI*2;
    const end=e.parameterStart+sweep;
    const count=Math.max(24,Math.min(192,Math.ceil((end-e.parameterStart)*32)));
    const sample=(t:number)=>{
     const sin=Math.sin(t),cos=Math.cos(t);
     return {x:center.x+major.x*cos-major.y*e.ratio*sin,
      y:center.y+major.y*cos+major.x*e.ratio*sin};
    };
    let start=sample(e.parameterStart);
    for(let i=1;i<=count;i++){
     const next=sample(e.parameterStart+(end-e.parameterStart)*i/count);
     line(start.x,start.y,next.x,next.y,e.layer);start=next;
    }
    break;
   }
   case "POINT":{
    const c=e.points[0];if(!c)break;
    const d=Math.max(e.height*.08,.04);
    line(c.x-d,c.y,c.x+d,c.y,e.layer);
    line(c.x,c.y-d,c.x,c.y+d,e.layer);
    break;
   }
   case "SPLINE":{
    const output=sampleSpline({
     degree:e.degree,
     controls:e.splineControls.map(p=>({x:p.x,y:p.y})),
     knots:e.knots,weights:e.weights,
    });
    if(output.error){skipped.add("SPLINE: "+output.error);break;}
    for(let i=1;i<output.points.length;i++){
     const a=output.points[i-1]!,b=output.points[i]!;
     line(a.x,a.y,b.x,b.y,e.layer);
    }
    break;
   }
   case "HATCH":drawHatch(e);break;
   case "SOLID":drawSolid(e);break;
   case "LWPOLYLINE":
   case "POLYLINE":{
    if(e.points.length<2)break;
    for(let i=0;i+1<e.points.length;i++){
     const a=e.points[i];
     const b=e.points[i+1];
     if(a&&b)polySegment(a,b,e.layer);
    }
    if(e.closed&&e.points.length>2){
     const last=e.points[e.points.length-1];
     const first=e.points[0];
     if(last&&first)polySegment(last,first,e.layer);
    }
    break;
   }
   case "TEXT":
   case "MTEXT":{
    label(e);
    break;
   }
   case "VIEWPORT":{
    if(e.viewportId<=1)break; // viewport #1 is the paper view itself.
    viewportTotal++;
    const center=e.points[0];
    // AcDbViewport DXF 40=paper width, 41=paper height (NOT aspect).
    const width=e.raw.some(pair=>pair.code===40)?e.radius:0;
    const height=e.raw.some(pair=>pair.code===41)?e.scaleX:0;
    const aspect=width/height;
    if(!e.paperSpace&&!e.layout){skipped.add("VIEWPORT: 未指定图纸空间");break;}
    if(!center||![center.x,center.y,width,height].every(Number.isFinite)||
       width<=0||height<=0||width>1e12){
     skipped.add("VIEWPORT: 边界尺寸无效");break;
    }
    const hw=height*aspect/2,hh=height/2;
    const vertices=[
     {x:center.x-hw,y:center.y-hh},{x:center.x+hw,y:center.y-hh},
     {x:center.x+hw,y:center.y+hh},{x:center.x-hw,y:center.y+hh},
    ];
    for(let i=0;i<4;i++){
     const a=vertices[i]!,b=vertices[(i+1)%4]!;
     line(a.x,a.y,b.x,b.y,e.layer);
    }
    if(e.raw.some(pair=>pair.code===68&&Number(pair.value)===0))break;
    // Nonrectangular boundaries and perspective need a CAD layout kernel.
    // Standard viewport-frozen layer handles (331) are resolved below.
    const flags=Number(e.raw.find(pair=>pair.code===90)?.value??0);
    if((flags&(0x10000|0x20000|1))!==0||e.raw.some(pair=>pair.code===340||pair.code===441)){
     skipped.add("VIEWPORT: 透视或复杂边界未投影");break;
    }
    const frozen=new Set<string>(),frozenHandles=e.raw.filter(pair=>pair.code===331);
    let unresolvedFrozen=false;
    for(const entry of frozenHandles){
     const name=layerHandles.get(entry.value.trim().toUpperCase());
     if(!name){unresolvedFrozen=true;break;}
     frozen.add(name);
    }
    if(unresolvedFrozen){skipped.add("VIEWPORT: 冻结图层句柄无法解析");break;}
    const pick=(code:number)=>e.raw.find(pair=>pair.code===code);
    const viewX=pick(12),viewY=pick(22),viewHeight=pick(45);
    if(!viewX||!viewY||!viewHeight){
     skipped.add("VIEWPORT: 缺少模型视图中心或高度，仅绘制边框");break;
    }
    // This implementation supports a top-down planar XY orthographic view
    // only; reject tilted views instead of projecting their XY coordinates.
    const direction=[Number(pick(16)?.value??0),Number(pick(26)?.value??0),
     Number(pick(36)?.value??1)];
    if(direction.some(n=>!Number.isFinite(n))||
       Math.abs(direction[0]!)>1e-6||Math.abs(direction[1]!)>1e-6||
       Math.abs(direction[2]!-1)>1e-6){
     skipped.add("VIEWPORT: 三维倾斜视图尚不支持");break;
    }
    // DCS view center (12/22) is relative to WCS target (17/27) and
    // rotated by view twist (51, radians) before projection.
    const twist=Number(pick(51)?.value??0);
    const targetX=Number(pick(17)?.value??0),targetY=Number(pick(27)?.value??0);
    const dx=Number(viewX.value),dy=Number(viewY.value);
    const projection=createPaperViewport({
     paperCenter:{x:center.x,y:center.y},paperHeight:height,aspect,
     viewCenter:{x:targetX+Math.cos(twist)*dx-Math.sin(twist)*dy,
      y:targetY+Math.sin(twist)*dx+Math.cos(twist)*dy},
     viewHeight:Number(viewHeight.value),
     twistRadians:twist,
    });
    if(!projection){skipped.add("VIEWPORT: 投影比例或中心参数无效");break;}
    if(blockStack.size){skipped.add("VIEWPORT: 图块内嵌套视口尚不支持");break;}
    const previousColor=currentColor;
    // Model entities are normalized once and reused for each viewport.
    const model=getModelContents();
    let projectedItems=0;
    for(const stroke of model.strokes){
     if(emittedSegments>=MAX_SEGMENTS)break;
     if(frozen.has(stroke.layer))continue;
     const start=projection.project({x:stroke.x1,y:stroke.y1});
     const end=projection.project({x:stroke.x2,y:stroke.y2});
     const clipped=projection.clip({x1:start.x,y1:start.y,x2:end.x,y2:end.y});
     if(!clipped)continue;
     currentColor=stroke.color;
     line(clipped.x1,clipped.y1,clipped.x2,clipped.y2,stroke.layer);
     projectedItems++;
    }
    for(const fill of model.fills){
     if(frozen.has(fill.layer))continue;
     const polygons:UvPoint[][]=[];
     for(let i=0;i+2<fill.triangles.length;i+=3)
      polygons.push(fill.triangles.slice(i,i+3).map(point=>({...point,u:0,v:0})));
     if(projectFilled(polygons,projection,fill.layer,fill.color,fill.opacity))
      projectedItems++;
    }
    for(const label of model.labels){
     if(frozen.has(label.layer)||!Number.isFinite(label.width)||!Number.isFinite(label.height))continue;
     // SpriteMaterial rotation acts about the glyph quad's center.
     const c=Math.cos(label.rotation),s=Math.sin(label.rotation);
     const corners:[number,number,number,number][]=[
      [-.5,-.5,0,0],[.5,-.5,1,0],[.5,.5,1,1],[-.5,.5,0,1],
     ];
     const quad:UvPoint[]=corners.map(([x,y,u,v])=>{
      const xx=x*label.width,yy=y*label.height;
      return{x:label.center.x+c*xx-s*yy,y:label.center.y+s*xx+c*yy,u,v};
     });
     if(projectFilled([quad],projection,label.layer,label.color,label.opacity,label.image,.0001))
      projectedItems++;
    }
    currentColor=previousColor;
    if(projectedItems>0)viewportProjected++;
    else skipped.add("VIEWPORT: 当前范围内没有可投影的模型线段");
    break;
   }
   case "SECTION":
   case "ENDSEC":
   case "EOF":
   case "TABLE":
   case "ENDTAB":
   case "LAYER":
    break;
   default:
    if(e.type)skipped.add(e.type);
  }}finally{currentColor=previousColor;}
 };

 let entity=emptyEntity("");
 const normalizePolylines=(items:Entity[]):Entity[]=>{
  const normalized:Entity[]=[];
  let current:Entity|null=null;
  const flush=()=>{
   if(current){
    if(current.points.length>=2)normalized.push(current);
    else skipped.add("POLYLINE: 不足两个有效顶点");
   }
   current=null;
  };
  for(const item of items){
   if(item.type==="POLYLINE"){
    flush();current={...item,points:[]};
   }else if(item.type==="VERTEX"){
    if(current)current.points.push(...item.points);
    else skipped.add("VERTEX: 缺少 POLYLINE");
   }else if(item.type==="SEQEND"){
    flush();
   }else normalized.push(item);
  }
  flush();
  return normalized;
 };
 let sectionNamePending=false;
 let currentSection="";
 let blockHeader=false;
 let currentBlock:{name:string;base:Point;items:Entity[]}|null=null;
 const modelEntities:Entity[]=[];
 const finishEntity=()=>{
  if(!entity.type)return;
  if(currentSection==="ENTITIES")modelEntities.push(entity);
  else if(currentSection==="BLOCKS"&&currentBlock)currentBlock.items.push(entity);
 };
 for(const pair of records){
  if(pair.code===0){
   finishEntity();
   entity=emptyEntity("");
   if(pair.value==="SECTION"){sectionNamePending=true;currentSection="";continue;}
   if(pair.value==="ENDSEC"){currentSection="";continue;}
   if(currentSection==="BLOCKS"&&pair.value==="BLOCK"){
    currentBlock={name:"",base:{x:0,y:0,bulge:0},items:[]};
    blockHeader=true;continue;
   }
   if(currentSection==="BLOCKS"&&pair.value==="ENDBLK"){
    if(currentBlock?.name)blocks.set(currentBlock.name,{
     base:currentBlock.base,items:normalizePolylines(currentBlock.items),
    });
    currentBlock=null;blockHeader=false;continue;
   }
   if(currentSection==="ENTITIES"||(currentSection==="BLOCKS"&&currentBlock)){
    blockHeader=false;
    entity=emptyEntity(pair.value);
   }
   continue;
  }
  if(sectionNamePending&&pair.code===2){
   currentSection=pair.value.trim();
   sectionNamePending=false;continue;
  }
  if(blockHeader&&currentBlock){
   if(pair.code===2)currentBlock.name=pair.value.trim();
   if(pair.code===10)currentBlock.base.x=Number(pair.value);
   if(pair.code===20)currentBlock.base.y=Number(pair.value);
   continue;
  }
  if(currentSection!=="ENTITIES"&&currentSection!=="BLOCKS")continue;
  if(!entity.type)continue;
  switch(pair.code){
   case 8:entity.layer=pair.value.trim()||"0";break;
   case 7:if(entity.type==="TEXT"||entity.type==="MTEXT")entity.textStyle=pair.value.trim()||"STANDARD";break;
   case 410:entity.layout=pair.value.trim();break;
   case 67:entity.paperSpace=Number(pair.value)===1;break;
   case 2:if(entity.type==="INSERT"||entity.type==="DIMENSION")entity.blockName=pair.value.trim();break;
   case 10:
    if(entity.type==="SPLINE")entity.splineControls.push({x:Number(pair.value),y:0,bulge:0});
    else entity.points.push({x:Number(pair.value),y:0,bulge:0});
    break;
   case 20:{
    const arr=entity.type==="SPLINE"?entity.splineControls:entity.points;
    const last=arr[arr.length-1];
    if(last)last.y=Number(pair.value);
    break;
   }
   case 11:
    if(entity.type==="ELLIPSE")entity.major={x:Number(pair.value),y:0,bulge:0};
    else entity.end={x:Number(pair.value),y:0,bulge:0};
    break;
   case 21:
    if(entity.type==="ELLIPSE"&&entity.major)entity.major.y=Number(pair.value);
    else if(entity.end)entity.end.y=Number(pair.value);
    break;
   case 40:
    if(entity.type==="ELLIPSE")entity.ratio=Number(pair.value);
    else if(entity.type==="SPLINE")entity.knots.push(Number(pair.value));
    else {
     entity.radius=Number(pair.value);
     if(entity.type==="TEXT"||entity.type==="MTEXT")entity.height=Number(pair.value);
    }
    break;
   case 41:
    if(entity.type==="INSERT")entity.scaleX=Number(pair.value);
    if(entity.type==="VIEWPORT")entity.scaleX=Number(pair.value);
    if(entity.type==="TEXT")entity.textWidthFactor=Number(pair.value);
    if(entity.type==="ELLIPSE")entity.parameterStart=Number(pair.value);
    if(entity.type==="SPLINE")entity.weights.push(Number(pair.value));
    break;
   case 50:
    if(entity.type==="INSERT")entity.rotation=Number(pair.value);
    else entity.a0=Number(pair.value);
    break;
   case 51:entity.a1=Number(pair.value);break;
   case 70:entity.closed=(Number.parseInt(pair.value,10)&1)===1;break;
   case 71:
    if(entity.type==="SPLINE")entity.degree=Number(pair.value);
    if(entity.type==="MTEXT")entity.mTextAttachment=Number(pair.value);
    break;
   case 72:if(entity.type==="TEXT")entity.hAlign=Number(pair.value);break;
   case 73:if(entity.type==="TEXT")entity.vAlign=Number(pair.value);break;
   case 69:if(entity.type==="VIEWPORT")entity.viewportId=Number(pair.value);break;
   case 60:entity.invisible=Number(pair.value)===1;break;
   case 62:entity.colorIndex=Number(pair.value);break;
   case 420:entity.trueColor=Number(pair.value)&0xffffff;break;
   case 42:{
    if(entity.type==="INSERT")entity.scaleY=Number(pair.value);
    else if(entity.type==="ELLIPSE")entity.parameterEnd=Number(pair.value);
    else{
     const last=entity.points[entity.points.length-1];
     if(last)last.bulge=Number(pair.value);
    }
    break;
   }
   case 1:entity.text+=pair.value;break;
   case 3:
    // MTEXT group 3 chunks precede the final group 1; keep source order.
    if(entity.type==="MTEXT")entity.text+=pair.value;
    else if(entity.type!=="DIMENSION")entity.text=pair.value+entity.text;
    break;
  }
  entity.raw.push(pair);
 }
 finishEntity();
 // BLOCK definitions may occur after model-space entities. Resolve references
 // only after collecting the entire file, including forward references.
 const entityLayout=(e:Entity)=>{
  if(e.layout)return e.layout.toLowerCase()==="model"?"Model":e.layout;
  return e.paperSpace?"Paper Space":"Model";
 };
 const layouts=["Model",...new Set(modelEntities.map(entityLayout).filter(name=>name!=="Model"))];
 const layout=layouts.includes(requestedLayout)?requestedLayout:"Model";
 for(const item of normalizePolylines(modelEntities).filter(e=>entityLayout(e)===layout)){
  if(visitedEntities>=MAX_ENTITIES||emittedSegments>=MAX_SEGMENTS)break;
  commit(item);
 }

 // One draw call per layer for linework instead of one per DXF segment.
 for(const [key,coordinates] of segmentBuffers){
  if(!coordinates.length)continue;
  const boundary=key.lastIndexOf("\u0000");
  const layer=key.slice(0,boundary),color=Number(key.slice(boundary+1));
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(coordinates,3));
  groupFor(layer).add(new THREE.LineSegments(geometry,
   new THREE.LineBasicMaterial({color})));
 }

 const layers=layerOrder.map(name=>({name,visible:layerGroups.get(name)?.visible??true}));
 return {object:root,layers,skipped:Array.from(skipped),unit,layouts,layout,
  viewports:{total:viewportTotal,projected:viewportProjected}};
}
