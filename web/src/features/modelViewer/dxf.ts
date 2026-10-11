// Model-space DXF renderer: readable layer colours, batched segments and labels.
//
// Two passes: the LAYER table (name + ACI colour), then the ENTITIES section.
// Supported: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE/VERTEX/SEQEND and
// TEXT/MTEXT are rendered as glyph sprites. Each layer becomes a child group,
// and layer colours come from the drawing's own ACI index — never the brand
// palette. Anything else is reported as skipped, never silently dropped.
import type * as THREE from "three";

export type DxfParseResult={
 object:THREE.Group;
 layers:{name:string;visible:boolean}[];
 skipped:string[];
 unit:string;
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
};

function emptyEntity(type:string):Entity{
 return {type,layer:"0",points:[],end:null,radius:0,a0:0,a1:360,closed:false,height:2.5,text:""};
}

export function parseDxf(text:string,THREE:typeof import("three")):DxfParseResult{
 const records=pairs(text);

 // Pass 1 — HEADER units and LAYER table.
 const layerColors=new Map<string,number>();
 const hiddenLayers=new Set<string>();
 let unit="unknown";
 let section="";
 let table="";
 let pendingLayer="";
 let sectionPending=false;
 let tablePending=false;
 let unitPending=false;
 for(const pair of records){
  if(pair.code===0){
   if(pair.value==="SECTION"){sectionPending=true;continue;}
   if(pair.value==="ENDSEC"){section="";continue;}
   if(pair.value==="TABLE"){tablePending=true;continue;}
   if(pair.value==="LAYER"&&table==="LAYER"){pendingLayer="";continue;}
   if(pair.value==="ENDTAB"){table="";pendingLayer="";continue;}
   continue;
  }
  if(pair.code===2&&sectionPending){section=pair.value.trim();sectionPending=false;continue;}
  if(pair.code===2&&tablePending){table=pair.value.trim();tablePending=false;continue;}
  if(section==="HEADER"){
   if(pair.code===9)unitPending=pair.value.trim()==="$INSUNITS";
   else if(unitPending&&pair.code===70){unit=UNITS[Number(pair.value)]??"unknown";unitPending=false;}
  }
  if(section==="TABLES"&&table==="LAYER"){
   if(pair.code===2)pendingLayer=pair.value.trim();
   if(pair.code===62&&pendingLayer)layerColors.set(pendingLayer,Number.parseInt(pair.value,10)||7);
   if(pair.code===70&&pendingLayer&&(Number(pair.value)&1)!==0)hiddenLayers.add(pendingLayer);
  }
 }
 const layerColor=(name:string)=>layerColors.get(name)??7;

 // Pass 2 — entities.
 const root=new THREE.Group();
 root.name="dxf";
 const layerGroups=new Map<string,THREE.Group>();
 const segmentBuffers=new Map<string,number[]>();
 const layerOrder:string[]=[];
 const skipped=new Set<string>();

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
  groupFor(layer);
  let coordinates=segmentBuffers.get(layer);
  if(!coordinates){coordinates=[];segmentBuffers.set(layer,coordinates);}
  coordinates.push(x1,y1,0,x2,y2,0);
 };
 const arc=(x:number,y:number,r:number,from:number,to:number,layer:string)=>{
  if(![x,y,r,from,to].every(Number.isFinite)||r<=0)return;
  let end=to;
  while(end<=from)end+=360;
  const sweep=(end-from)*Math.PI/180;
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
 const label=(text:string,x:number,y:number,h:number,layer:string)=>{
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(h)||h<=0)return;
  const content=text.replace(/\\P/g,"\n").replace(/\{\\[^;]*;/g,"").replace(/[{}]/g,"").slice(0,400);
  const rows=content.split("\n").slice(0,8);
  if(!content.trim())return;
  const canvas=document.createElement("canvas");
  const context=canvas.getContext("2d");
  if(!context){skipped.add("TEXT");return;}
  const fontSize=60;
  context.font="500 "+fontSize+"px Arial, 'Microsoft YaHei', sans-serif";
  canvas.width=Math.min(4096,Math.ceil(Math.max(20,...rows.map(row=>context.measureText(row).width))+12));
  canvas.height=Math.ceil((fontSize+12)*rows.length);
  context.font="500 "+fontSize+"px Arial, 'Microsoft YaHei', sans-serif";
  context.textBaseline="top";
  context.fillStyle="#"+aciColor(layerColor(layer)).toString(16).padStart(6,"0");
  rows.forEach((row,index)=>context.fillText(row,4,index*(fontSize+12)));
  const texture=new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));
  sprite.scale.set(canvas.width/fontSize*h,canvas.height/fontSize*h,1);
  sprite.position.set(x+sprite.scale.x/2,y+sprite.scale.y/2,0);
  groupFor(layer).add(sprite);
 };

 const commit=(e:Entity)=>{
  // POLYLINE geometry arrives as separate VERTEX entities; accumulate them and
  // emit on SEQEND. LWPOLYLINE carries its vertices inline.
  if(e.type==="VERTEX"){
   if(e.points.length){polyVerts.push(...e.points);polyLayer=e.layer;}
   return;
  }
  if(e.type==="SEQEND"){
   if(polyVerts.length>1){
    const p=emptyEntity("POLYLINE");
    p.points=polyVerts;
    p.layer=polyLayer;
    p.closed=polyClosed;
    commit(p);
   }
   polyVerts=[];polyClosed=false;
   return;
  }
  if(e.type==="POLYLINE"){
   polyVerts=[];polyLayer=e.layer;polyClosed=e.closed;
   return;
  }
  switch(e.type){
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
    if(c&&e.radius>0)arc(c.x,c.y,e.radius,e.a0,e.a1||360,e.layer);
    break;
   }
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
    const c=e.points[0];
    if(c)label(e.text,c.x,c.y,e.height,e.layer);
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
  }
 };

 let entity=emptyEntity("");
 let polyVerts:Point[]=[];
 let polyLayer="0";
 let polyClosed=false;
 let inEntities=false;
 let sectionNamePending=false;
 for(const pair of records){
  if(pair.code===0){
   if(inEntities&&entity.type)commit(entity);
   entity=emptyEntity("");
   if(pair.value==="SECTION"){sectionNamePending=true;inEntities=false;continue;}
   if(pair.value==="ENDSEC"){inEntities=false;continue;}
   if(inEntities)entity=emptyEntity(pair.value);
   continue;
  }
  if(sectionNamePending&&pair.code===2){
   inEntities=pair.value.trim()==="ENTITIES";
   sectionNamePending=false;continue;
  }
  if(!inEntities)continue;
  if(!entity.type)continue;
  switch(pair.code){
   case 8:entity.layer=pair.value.trim()||"0";break;
   case 10:entity.points.push({x:Number(pair.value),y:0,bulge:0});break;
   case 20:{
    const last=entity.points[entity.points.length-1];
    if(last)last.y=Number(pair.value);
    break;
   }
   case 11:entity.end={x:Number(pair.value),y:0,bulge:0};break;
   case 21:if(entity.end)entity.end.y=Number(pair.value);break;
   case 40:entity.radius=Number(pair.value);if(entity.type==="TEXT"||entity.type==="MTEXT")entity.height=Number(pair.value);break;
   case 50:entity.a0=Number(pair.value);break;
   case 51:entity.a1=Number(pair.value);break;
   case 70:entity.closed=(Number.parseInt(pair.value,10)&1)===1;break;
   case 42:{
    const last=entity.points[entity.points.length-1];
    if(last)last.bulge=Number(pair.value);
    break;
   }
   case 1:entity.text+=pair.value;break;
   case 3:entity.text=pair.value+entity.text;break;
  }
 }
 if(inEntities&&entity.type)commit(entity);

 // One draw call per layer for linework instead of one per DXF segment.
 for(const [layer,coordinates] of segmentBuffers){
  if(!coordinates.length)continue;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(coordinates,3));
  groupFor(layer).add(new THREE.LineSegments(geometry,
   new THREE.LineBasicMaterial({color:aciColor(layerColor(layer))})));
 }

 const layers=layerOrder.map(name=>({name,visible:layerGroups.get(name)?.visible??true}));
 return {object:root,layers,skipped:Array.from(skipped),unit};
}
