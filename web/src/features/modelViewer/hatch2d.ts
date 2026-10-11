/** Strict DXF HATCH subset: solid fill with closed polyline boundaries.
 * Rejection is deliberate: converting an unknown pattern or open edge path
 * to solid colour would produce a misleading engineering drawing. */
export type HatchPair={code:number;value:string};
export type HatchPoint={x:number;y:number};
export type HatchResult={rings:HatchPoint[][];error?:string};
const MAX_PATHS=64,MAX_VERTICES=12000;

function bulgePoints(a:HatchPoint,b:HatchPoint,bulge:number):HatchPoint[]{
 if(Math.abs(bulge)<1e-9)return [a];
 const theta=4*Math.atan(bulge),chord=Math.hypot(b.x-a.x,b.y-a.y);
 if(!Number.isFinite(theta)||chord<1e-12)return [a];
 const tangent=Math.tan(theta/2);
 if(Math.abs(tangent)<1e-12)return[a];
 const cx=(a.x+b.x)/2-(b.y-a.y)/(2*tangent);
 const cy=(a.y+b.y)/2+(b.x-a.x)/(2*tangent);
 const radius=Math.hypot(a.x-cx,a.y-cy);
 if(!Number.isFinite(radius)||radius>1e12)return[a];
 const start=Math.atan2(a.y-cy,a.x-cx);
 const count=Math.min(96,Math.max(8,Math.ceil(Math.abs(theta)*20)));
 return Array.from({length:count},(_,index)=>{
  const angle=start+theta*index/count;
  return{x:cx+radius*Math.cos(angle),y:cy+radius*Math.sin(angle)};
 });
}

export function parseHatchPaths(pairs:readonly HatchPair[]):HatchResult{
 const scalar=(code:number)=>pairs.find(p=>p.code===code)?.value;
 if(Number(scalar(70))!==1)return{rings:[],error:"非实心图案或渐变填充"};
 if(Number(scalar(75)??0)!==0)return{rings:[],error:"岛屿填充规则尚不支持"};
 const expected=Number(scalar(91));
 if(!Number.isInteger(expected)||expected<1||expected>MAX_PATHS)
  return{rings:[],error:"边界路径数量无效或超限"};
 const first=pairs.findIndex(p=>p.code===91);
 if(first<0)return{rings:[],error:"缺少边界路径"};
 const rings:HatchPoint[][]=[];
 let total=0,rendered=0,i=first+1;
 for(let path=0;path<expected;path++){
  while(i<pairs.length&&pairs[i]!.code!==92)i++;
  if(i>=pairs.length)return{rings:[],error:"边界路径不完整"};
  const flags=Number(pairs[i++]!.value);
  if(!Number.isFinite(flags)||(flags&2)===0)
   return{rings:[],error:"包含尚不支持的曲线或边类型"};
  let closed=false,bulges=false,count=-1;
  while(i<pairs.length&&pairs[i]!.code!==93&&pairs[i]!.code!==92){
   const item=pairs[i++]!;
   if(item.code===72)bulges=Number(item.value)!==0;
   if(item.code===73)closed=Number(item.value)===1;
  }
  if(i>=pairs.length||pairs[i]!.code!==93)return{rings:[],error:"缺少边界顶点数量"};
  count=Number(pairs[i++]!.value);
  if(!closed||!Number.isInteger(count)||count<3||count>MAX_VERTICES-total)
   return{rings:[],error:"填充路径不闭合或顶点数量超限"};
  const vertices:{x:number;y:number;bulge:number}[]=[];
  let pendingX:number|null=null;
  let pendingY:number|null=null;
  let pendingBulge=0;
  const finish=()=>{
   if(pendingX!==null&&pendingY!==null){
    vertices.push({x:pendingX,y:pendingY,bulge:pendingBulge});
   }
   pendingX=null;pendingY=null;pendingBulge=0;
  };
  while(i<pairs.length&&vertices.length<count){
   const item=pairs[i++]!,value=Number(item.value);
   if(item.code===10){finish();pendingX=value;}
   if(item.code===20)pendingY=value;
   if(item.code===42)pendingBulge=value;
   if(item.code===92){i--;break;}
   if(item.code===97)break;
  }
  finish();
  if(vertices.length!==count||vertices.some(v=>![v.x,v.y,v.bulge].every(Number.isFinite)))
   return{rings:[],error:"边界顶点损坏"};
  total+=count;
  const ring:HatchPoint[]=[];
  for(let j=0;j<vertices.length;j++){
   const a=vertices[j]!,b=vertices[(j+1)%vertices.length]!;
   ring.push(...bulgePoints(a,b,bulges?a.bulge:0));
   if(ring.length+rendered>MAX_VERTICES)return{rings:[],error:"曲线离散化预算超限"};
  }
  if(ring.length<3)return{rings:[],error:"填充边界退化"};
  rendered+=ring.length;
  rings.push(ring);
 }
 return{rings};
}
