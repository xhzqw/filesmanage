import type {HatchPattern,HatchPoint} from "./hatch2d";

export type HatchStroke={x1:number;y1:number;x2:number;y2:number};
export type HatchPatternResult={strokes:HatchStroke[];error?:string};
const LINE_LIMIT=512,STROKE_LIMIT=30000,VERTEX_LIMIT=4000;

/** DXF pattern families clipped to even-odd hatch contours. A line family has
 * an angle, origin and *vector* offset; this must not be approximated with
 * axis-aligned canvas stripes or a bounding box. */
export function clipHatchPattern(rings:readonly (readonly HatchPoint[])[],patterns:readonly HatchPattern[]):HatchPatternResult{
 const fail=(error:string):HatchPatternResult=>({strokes:[],error});
 if(rings.length===0||patterns.length===0)return fail("缺少边界或图案线定义");
 const all=rings.flat(),xs=all.map(v=>v.x),ys=all.map(v=>v.y);
 if(all.length>VERTEX_LIMIT)return fail("图案填充边界过于复杂");
 if(!all.length||!all.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y)))
  return fail("填充边界坐标无效");
 const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const diagonal=Math.hypot(maxX-minX,maxY-minY);
 if(!Number.isFinite(diagonal)||diagonal===0)return fail("填充边界退化");
 const eps=Math.max(diagonal*1e-9,1e-10);
 const strokes:HatchStroke[]=[];
 const inside=(x:number,y:number)=>{
  let parity=false;
  for(const ring of rings){
   for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i]!,b=ring[j]!;
    if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)
     parity=!parity;
   }
  }
  return parity;
 };
 const put=(origin:HatchPoint,dx:number,dy:number,a:number,b:number)=>{
  if(b-a<=eps)return;
  if(strokes.length>=STROKE_LIMIT)throw Error("图案线段超出预算");
  strokes.push({
   x1:origin.x+dx*a,y1:origin.y+dy*a,
   x2:origin.x+dx*b,y2:origin.y+dy*b,
  });
 };
 try{
  for(const pattern of patterns){
   const angle=pattern.angle*Math.PI/180;
   const dx=Math.cos(angle),dy=Math.sin(angle),nx=-dy,ny=dx;
   const step=nx*pattern.offset.x+ny*pattern.offset.y;
   if(!Number.isFinite(step)||Math.abs(step)<=eps)return fail("图案线间距无效");
   const projected=[
    {x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY},
   ].map(v=>(v.x-pattern.base.x)*nx+(v.y-pattern.base.y)*ny);
   const distances=projected.map(value=>value/step);
   const start=Math.ceil(Math.min(...distances)-eps/Math.abs(step));
   const end=Math.floor(Math.max(...distances)+eps/Math.abs(step));
   if(end-start>LINE_LIMIT)return fail("图案线密度超出预算");
   const dash=pattern.dashes;
   const period=dash.reduce((sum,v)=>sum+Math.abs(v),0);
   if(dash.length>0&&(!Number.isFinite(period)||period<=eps))
    return fail("图案虚线周期无效");
   for(let n=start;n<=end;n++){
    const origin={
     x:pattern.base.x+n*pattern.offset.x,
     y:pattern.base.y+n*pattern.offset.y,
    };
    const crossings:number[]=[];
    for(const ring of rings)for(let i=0;i<ring.length;i++){
     const a=ring[i]!,b=ring[(i+1)%ring.length]!;
     const normalA=(a.x-origin.x)*nx+(a.y-origin.y)*ny;
     const normalB=(b.x-origin.x)*nx+(b.y-origin.y)*ny;
     if((normalA>eps&&normalB>eps)||(normalA< -eps&&normalB< -eps))continue;
     const difference=normalA-normalB;
     if(Math.abs(difference)<eps)continue;
     const portion=normalA/difference;
     if(portion< -1e-9||portion>=1-1e-9)continue;
     const x=a.x+(b.x-a.x)*portion,y=a.y+(b.y-a.y)*portion;
     crossings.push((x-origin.x)*dx+(y-origin.y)*dy);
    }
    crossings.sort((a,b)=>a-b);
    const unique=crossings.filter((v,i)=>i===0||Math.abs(v-crossings[i-1]!)>eps);
    for(let i=1;i<unique.length;i++){
     const a=unique[i-1]!,b=unique[i]!;
     const middle=(a+b)/2;
     if(b-a<=eps||!inside(origin.x+dx*middle,origin.y+dy*middle))continue;
     if(!dash.length){put(origin,dx,dy,a,b);continue;}
     // Dash phase is anchored to the DXF hatch family base. Negative entries
     // are gaps; zero entries are dots drawn as a tiny, scale-relative stroke.
     const firstPeriod=Math.floor(a/period);
     const lastPeriod=Math.ceil(b/period);
     if(lastPeriod-firstPeriod>STROKE_LIMIT)return fail("图案虚线密度超出预算");
     for(let cycle=firstPeriod;cycle<lastPeriod;cycle++){
      let cursor=cycle*period;
      for(const item of dash){
       const size=Math.abs(item);
       if(item>0)put(origin,dx,dy,Math.max(a,cursor),Math.min(b,cursor+size));
       else if(item===0){
        const dot=Math.max(Math.min(period*.02,diagonal*.0004),eps*2);
        put(origin,dx,dy,Math.max(a,cursor-dot/2),Math.min(b,cursor+dot/2));
       }
       cursor+=size;
      }
     }
    }
   }
  }
 }catch(error){return fail(error instanceof Error?error.message:"图案渲染预算超限");}
 return{strokes};
}
