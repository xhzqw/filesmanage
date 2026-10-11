/** Bounded 2D orthographic model-to-paper projection for a rectangular DXF
 * VIEWPORT. All calculations use document units / double precision.
 * This is not a 3D camera or a complete AutoCAD layout renderer. */
export type Point2={x:number;y:number};
export type Segment2={x1:number;y1:number;x2:number;y2:number};
export type PaperViewport={
 paperCenter:Point2;
 paperHeight:number;
 aspect:number;
 viewCenter:Point2;
 viewHeight:number;
 twistRadians:number;
};
export type Rect2={minX:number;minY:number;maxX:number;maxY:number};
export type UvPoint=Point2&{u:number;v:number};
/** Sutherland-Hodgman clipping, interpolating texture UVs along edges. */
export function clipUvPolygon(vertices:readonly UvPoint[],bounds:Rect2):UvPoint[]{
 let result=[...vertices];
 const edges=[
  {coordinate:"x" as const,bound:bounds.minX,keepAbove:true},
  {coordinate:"x" as const,bound:bounds.maxX,keepAbove:false},
  {coordinate:"y" as const,bound:bounds.minY,keepAbove:true},
  {coordinate:"y" as const,bound:bounds.maxY,keepAbove:false},
 ];
 for(const edge of edges){
  const input=result;result=[];
  for(let i=0;i<input.length;i++){
   const a=input[i]!,b=input[(i+1)%input.length]!;
   const inside=(p:UvPoint)=>edge.keepAbove?p[edge.coordinate]>=edge.bound:p[edge.coordinate]<=edge.bound;
   const ain=inside(a),bin=inside(b);
   if(ain!==bin){
    const denominator=b[edge.coordinate]-a[edge.coordinate];
    if(Math.abs(denominator)>1e-15){
     const t=(edge.bound-a[edge.coordinate])/denominator;
     result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,
      u:a.u+(b.u-a.u)*t,v:a.v+(b.v-a.v)*t});
    }
   }
   if(bin)result.push(b);
  }
  if(result.length===0)break;
 }
 return result;
}
export type ValidViewport={project:(p:Point2)=>Point2;clip:(segment:Segment2)=>Segment2|null;bounds:Rect2};
export function createPaperViewport(spec:PaperViewport):ValidViewport|null{
 const numbers=[spec.paperCenter.x,spec.paperCenter.y,spec.paperHeight,spec.aspect,
  spec.viewCenter.x,spec.viewCenter.y,spec.viewHeight,spec.twistRadians];
 if(!numbers.every(v=>Number.isFinite(v)&&Math.abs(v)<1e12)||
  spec.paperHeight<=0||spec.aspect<=0||spec.aspect>1000||
  spec.viewHeight<=1e-10||spec.paperHeight*spec.aspect>=1e12)return null;
 const width=spec.paperHeight*spec.aspect,hw=width/2,hh=spec.paperHeight/2;
 const bounds={minX:spec.paperCenter.x-hw,maxX:spec.paperCenter.x+hw,
  minY:spec.paperCenter.y-hh,maxY:spec.paperCenter.y+hh};
 const twist=spec.twistRadians;
 const cos=Math.cos(twist),sin=Math.sin(twist),scale=spec.paperHeight/spec.viewHeight;
 const project=(p:Point2):Point2=>{
  const x=p.x-spec.viewCenter.x,y=p.y-spec.viewCenter.y;
  return{x:spec.paperCenter.x+scale*(cos*x+sin*y),
   y:spec.paperCenter.y+scale*(-sin*x+cos*y)};
 };
 const clip=(segment:Segment2):Segment2|null=>{
  const {x1,y1,x2,y2}=segment;
  if(![x1,y1,x2,y2].every(Number.isFinite))return null;
  const vx=x2-x1,vy=y2-y1;
  let enter=0,leave=1;
  // Liang-Barsky: clip against all four half-planes.
  const constraints:[number,number][]=[
   [-vx,x1-bounds.minX],[vx,bounds.maxX-x1],
   [-vy,y1-bounds.minY],[vy,bounds.maxY-y1],
  ];
  for(const [p,q] of constraints){
   if(Math.abs(p)<1e-14){if(q<0)return null;continue;}
   const ratio=q/p;
   if(p<0)enter=Math.max(enter,ratio);else leave=Math.min(leave,ratio);
   if(enter>leave)return null;
  }
  if(leave-enter<1e-12)return null;
  return{x1:x1+enter*vx,y1:y1+enter*vy,x2:x1+leave*vx,y2:y1+leave*vy};
 };
 return{project,clip,bounds};
}
