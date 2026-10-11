/** Strict DXF HATCH subset: solid/polyline-boundary pattern hatch.
 * Unsupported edge paths and gradient fills are reported instead of guessed. */
export type HatchPair={code:number;value:string};
export type HatchPoint={x:number;y:number};
export type HatchPattern={angle:number;base:HatchPoint;offset:HatchPoint;dashes:number[]};
export type HatchResult={rings:HatchPoint[][];patterns:HatchPattern[];solid:boolean;error?:string};
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
 const failure=(error:string):HatchResult=>({rings:[],patterns:[],solid:false,error});
 if(pairs.some(p=>p.code===450&&Number(p.value)!==0))
  return failure("渐变填充尚不支持");
 const mode=Number(scalar(70));
 if(mode!==0&&mode!==1)return failure("未知的填充模式");
 if(Number(scalar(75)??0)!==0)return failure("岛屿填充规则尚不支持");
 const expected=Number(scalar(91));
 if(!Number.isInteger(expected)||expected<1||expected>MAX_PATHS)
  return failure("边界路径数量无效或超限");
 const first=pairs.findIndex(p=>p.code===91);
 if(first<0)return failure("缺少边界路径");
 const rings:HatchPoint[][]=[];
 let total=0,rendered=0,i=first+1;
 for(let path=0;path<expected;path++){
  while(i<pairs.length&&pairs[i]!.code!==92)i++;
  if(i>=pairs.length)return failure("边界路径不完整");
  const flags=Number(pairs[i++]!.value);
  if(!Number.isFinite(flags)||(flags&2)===0)
   return failure("包含尚不支持的曲线或边类型");
  let closed=false,bulges=false,count=-1;
  while(i<pairs.length&&pairs[i]!.code!==93&&pairs[i]!.code!==92){
   const item=pairs[i++]!;
   if(item.code===72)bulges=Number(item.value)!==0;
   if(item.code===73)closed=Number(item.value)===1;
  }
  if(i>=pairs.length||pairs[i]!.code!==93)return failure("缺少边界顶点数量");
  count=Number(pairs[i++]!.value);
  if(!closed||!Number.isInteger(count)||count<3||count>MAX_VERTICES-total)
   return failure("填充路径不闭合或顶点数量超限");
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
   return failure("边界顶点损坏");
  total+=count;
  const ring:HatchPoint[]=[];
  for(let j=0;j<vertices.length;j++){
   const a=vertices[j]!,b=vertices[(j+1)%vertices.length]!;
   ring.push(...bulgePoints(a,b,bulges?a.bulge:0));
   if(ring.length+rendered>MAX_VERTICES)return failure("曲线离散化预算超限");
  }
  if(ring.length<3)return failure("填充边界退化");
  rendered+=ring.length;
  rings.push(ring);
 }
 const patterns:HatchPattern[]=[];
 if(mode===0){
  const start=pairs.findIndex((pair,index)=>index>=i&&pair.code===78);
  if(start<0)return failure("缺少图案定义");
  const number=Number(pairs[start]!.value);
  if(!Number.isInteger(number)||number<1||number>16)return failure("图案线族数量无效或超限");
  let j=start+1;
  for(let family=0;family<number;family++){
   const get=(code:number)=>{
    if(pairs[j]?.code!==code)return null;
    return Number(pairs[j++]!.value);
   };
   const angle=get(53),x=get(43),y=get(44),dx=get(45),dy=get(46);
   const rawCount=get(79),count=rawCount??-1;
   if([angle,x,y,dx,dy,rawCount].some(n=>n===null||!Number.isFinite(n))||
      !Number.isInteger(count)||count<0||count>32)return failure("图案线参数不完整或超限");
   const dashes:number[]=[];
   for(let n=0;n<count;n++){
    const length=get(49);
    if(length===null||!Number.isFinite(length)||Math.abs(length)>1e9)
     return failure("图案虚线参数错误");
    dashes.push(length);
   }
   patterns.push({angle:angle!,base:{x:x!,y:y!},offset:{x:dx!,y:dy!},dashes});
  }
 }
 return{rings,patterns,solid:mode===1};
}
