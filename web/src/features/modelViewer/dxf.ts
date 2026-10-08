// Minimal DXF reader for the 2D drawing viewer (SPEC §20.3 DRW01/DRW02).
//
// Two passes: the LAYER table (name + ACI colour), then the ENTITIES section.
// Supported: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE/VERTEX/SEQEND and
// TEXT/MTEXT (rendered as an insertion marker, since glyph geometry needs a
// font). Each layer becomes a child group so the viewer can toggle visibility,
// and layer colours come from the drawing's own ACI index — never the brand
// palette. Anything else is reported as skipped, never silently dropped.
import type * as THREE from "three";

export type DxfParseResult={
 object:THREE.Group;
 layers:{name:string;visible:boolean}[];
 skipped:string[];
};

const ACI:Record<number,number>={1:0xff0000,2:0xffff00,3:0x00ff00,4:0x00ffff,5:0x0000ff,6:0xff00ff,7:0xffffff};

function aciColor(code:number):number{
 if(ACI[code])return ACI[code];
 // Unknown ACI indices keep a stable readable hue instead of claiming to be
 // the exact CAD colour.
 return ((code*67)%0xffffff)|0;
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
};

function emptyEntity(type:string):Entity{
 return {type,layer:"0",points:[],end:null,radius:0,a0:0,a1:360,closed:false,height:1};
}

export function parseDxf(text:string,THREE:typeof import("three")):DxfParseResult{
 const records=pairs(text);

 // Pass 1 — the LAYER table: name and ACI colour.
 const layerColors=new Map<string,number>();
 let section="";
 let table="";
 let pendingLayer="";
 for(const pair of records){
  if(pair.code===0){
   if(pair.value==="TABLE"){table="";}
   else if(pair.value==="LAYER"){pendingLayer="";}
   else if(pair.value==="ENDTAB"){table="";pendingLayer="";}
   continue;
  }
  if(pair.code===2&&!section&&!table)section=pair.value;
  if(pair.code===2&&table==="LAYER")pendingLayer=pair.value.trim();
  if(pair.code===62&&pendingLayer)layerColors.set(pendingLayer,Number.parseInt(pair.value,10)||7);
 }
 const layerColor=(name:string)=>layerColors.get(name)??7;

 // Pass 2 — entities.
 const root=new THREE.Group();
 root.name="dxf";
 const layerGroups=new Map<string,THREE.Group>();
 const layerOrder:string[]=[];
 const skipped=new Set<string>();

 const groupFor=(name:string)=>{
  let group=layerGroups.get(name);
  if(!group){
   group=new THREE.Group();
   group.name=name;
   group.userData.layer=name;
   layerGroups.set(name,group);
   layerOrder.push(name);
   root.add(group);
  }
  return group;
 };
 const line=(x1:number,y1:number,x2:number,y2:number,layer:string)=>{
  const geometry=new THREE.BufferGeometry().setFromPoints([
   new THREE.Vector3(x1,y1,0),new THREE.Vector3(x2,y2,0)]);
  groupFor(layer).add(new THREE.Line(geometry,
   new THREE.LineBasicMaterial({color:aciColor(layerColor(layer))})));
 };
 const arc=(x:number,y:number,r:number,from:number,to:number,layer:string)=>{
  const curve=new THREE.EllipseCurve(x,y,r,r,from*Math.PI/180,to*Math.PI/180,false,0);
  const points=curve.getPoints(64).map(p=>new THREE.Vector3(p.x,p.y,0));
  if(points.length<2)return;
  const geometry=new THREE.BufferGeometry().setFromPoints(points);
  groupFor(layer).add(new THREE.Line(geometry,
   new THREE.LineBasicMaterial({color:aciColor(layerColor(layer))})));
 };
 const marker=(x:number,y:number,h:number,layer:string)=>{
  const s=Math.max(h,0.5)*0.6;
  const axes:[number,number][]=[[1,0],[0,1]];
  for(const [dx,dy] of axes){
   line(x-dx*s,y-dy*s,x+dx*s,y+dy*s,layer);
  }
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
     if(a&&b)line(a.x,a.y,b.x,b.y,e.layer);
    }
    if(e.closed&&e.points.length>2){
     const last=e.points[e.points.length-1];
     const first=e.points[0];
     if(last&&first)line(last.x,last.y,first.x,first.y,e.layer);
    }
    break;
   }
   case "TEXT":
   case "MTEXT":{
    const c=e.points[0];
    if(c)marker(c.x,c.y,e.height,e.layer);
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
 for(const pair of records){
  if(pair.code===0){
   if(entity.type)commit(entity);
   entity=emptyEntity(pair.value);
   continue;
  }
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
   case 40:entity.radius=Number(pair.value);entity.height=Number(pair.value);break;
   case 50:entity.a0=Number(pair.value);break;
   case 51:entity.a1=Number(pair.value);break;
   case 70:entity.closed=(Number.parseInt(pair.value,10)&1)===1;break;
   case 42:{
    const last=entity.points[entity.points.length-1];
    if(last)last.bulge=Number(pair.value);
    break;
   }
  }
 }
 if(entity.type)commit(entity);

 const layers=layerOrder.map(name=>({name,visible:true}));
 return {object:root,layers,skipped:Array.from(skipped)};
}
