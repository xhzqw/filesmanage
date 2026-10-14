/** Evaluate a DXF SPLINE in homogeneous (rational B-spline) coordinates.
 * Source control points and knots stay double precision until the final
 * renderable segments are emitted by the viewer. Fit-point-only splines need
 * a separate interpolation procedure; never treat fit points as controls. */
export type SplinePoint={x:number;y:number};
export type SplineSpec={
 degree:number;
 controls:readonly SplinePoint[];
 knots:readonly number[];
 weights:readonly number[];
};
export type SplineSample={points:SplinePoint[];error?:string};

export function sampleSpline(spec:SplineSpec):SplineSample{
 const {degree,controls,knots,weights}=spec;
 const n=controls.length-1;
 if(!Number.isInteger(degree)||degree<1||degree>10||
    n<degree||n>20000||knots.length!==n+degree+2||
    (weights.length!==0&&weights.length!==controls.length)){
  return {points:[],error:"unsupported degree or inconsistent control/knot/weight counts"};
 }
 if(!controls.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&
       Math.abs(p.x)<1e12&&Math.abs(p.y)<1e12)||
    !knots.every(Number.isFinite)||
    !weights.every(w=>Number.isFinite(w)&&w>0)){
  return {points:[],error:"non-finite control, knot or invalid rational weight"};
 }
 for(let i=1;i<knots.length;i++){
  if(knots[i]! < knots[i-1]!)return {points:[],error:"non-monotonic knot vector"};
 }
 const start=knots[degree]!,end=knots[n+1]!;
 if(!(end>start))return {points:[],error:"zero-length parameter domain"};
 // An internal multiplicity p+1 permits a geometric discontinuity. Rendering
 // a single LineSegments strip would falsely bridge that gap; reject until
 // separate subcurve runs can be represented by the geometry layer.
 for(let i=degree+1;i<=n;){
  const knot=knots[i]!;
  let j=i+1;while(j<=n&&knots[j]===knot)j++;
  if(j-i>degree)return{points:[],error:"discontinuous internal knot spans"};
  i=j;
 }

 const evaluate=(u:number):SplinePoint|null=>{
  // The last knot belongs to the last nonempty span.
  let span=n;
  if(u<end){
   let lo=degree,hi=n+1;
   while(lo<hi){
    const mid=(lo+hi)>>1;
    if(knots[mid+1]!<=u)lo=mid+1;else hi=mid;
   }
   span=lo;
  }
  const d:{x:number;y:number;w:number}[]=[];
  for(let j=0;j<=degree;j++){
   const i=span-degree+j;
   const p=controls[i]!,w=weights[i]??1;
   d.push({x:p.x*w,y:p.y*w,w});
  }
  for(let r=1;r<=degree;r++){
   for(let j=degree;j>=r;j--){
    const i=span-degree+j;
    const lower=knots[i]!,upper=knots[i+degree-r+1]!;
    const delta=upper-lower;
    const a=delta>0?(u-lower)/delta:0;
    d[j]={
     x:(1-a)*d[j-1]!.x+a*d[j]!.x,
     y:(1-a)*d[j-1]!.y+a*d[j]!.y,
     w:(1-a)*d[j-1]!.w+a*d[j]!.w,
    };
   }
  }
  const result=d[degree]!;
  if(!Number.isFinite(result.w)||Math.abs(result.w)<1e-15)return null;
  const x=result.x/result.w,y=result.y/result.w;
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)<1e12&&Math.abs(y)<1e12?{x,y}:null;
 };

 // Sample nonempty knot spans separately. This respects repeated knots and
 // never interpolates over a discontinuity at an internal multiplicity p+1.
 const nonempty:{lo:number;hi:number}[]=[];
 for(let i=degree;i<=n;i++){
  if(knots[i+1]!>knots[i]!)nonempty.push({lo:knots[i]!,hi:knots[i+1]!});
 }
 if(nonempty.length===0)return{points:[],error:"no nonempty knot spans"};
 const samples=Math.min(2048,Math.max(64,nonempty.length*24));
 const segmentsPerSpan=Math.max(2,Math.floor(samples/nonempty.length));
 const points:SplinePoint[]=[];
 for(const range of nonempty){
  for(let j=0;j<segmentsPerSpan;j++){
   const point=evaluate(range.lo+(range.hi-range.lo)*j/segmentsPerSpan);
   if(!point)return{points:[],error:"evaluation overflow"};
   points.push(point);
  }
 }
 const last=evaluate(end);
 if(!last)return{points:[],error:"endpoint evaluation overflow"};
 points.push(last);
 return {points};
}
