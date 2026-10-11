/** Geometry-space DXF object snaps. Coordinates are document units, not CSS
 * pixels. A bounded uniform-grid index avoids a full drawing scan on each
 * mouse move for typical plans. This index is viewport-independent. */
export type DrawingSegment={x1:number;y1:number;x2:number;y2:number};
export type DrawingSnap={x:number;y:number;kind:"endpoint"|"midpoint"|"nearest";distance:number};
export type DrawingSnapIndex={
 find:(x:number,y:number,tolerance:number)=>DrawingSnap|null;
 segmentCount:number;
};

export function createDrawingSnapIndex(segments:readonly DrawingSegment[]):DrawingSnapIndex{
 const valid=segments.filter(s=>[s.x1,s.y1,s.x2,s.y2].every(Number.isFinite));
 if(!valid.length)return{find:()=>null,segmentCount:0};
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(const s of valid){
  minX=Math.min(minX,s.x1,s.x2);maxX=Math.max(maxX,s.x1,s.x2);
  minY=Math.min(minY,s.y1,s.y2);maxY=Math.max(maxY,s.y1,s.y2);
 }
 const width=Math.max(maxX-minX,1e-8),height=Math.max(maxY-minY,1e-8);
 const cell=Math.max(Math.max(width,height)/Math.sqrt(Math.max(valid.length,1)),1e-8);
 const buckets=new Map<string,number[]>();
 const longSegments:number[]=[];
 const cellAt=(n:number,start:number)=>Math.floor((n-start)/cell);
 const key=(x:number,y:number)=>x+","+y;
 for(let i=0;i<valid.length;i++){
  const s=valid[i]!;
  const left=cellAt(Math.min(s.x1,s.x2),minX),right=cellAt(Math.max(s.x1,s.x2),minX);
  const top=cellAt(Math.min(s.y1,s.y2),minY),bottom=cellAt(Math.max(s.y1,s.y2),minY);
  if((right-left+1)*(bottom-top+1)>64){longSegments.push(i);continue;}
  for(let ix=left;ix<=right;ix++)for(let iy=top;iy<=bottom;iy++){
   const id=key(ix,iy),bucket=buckets.get(id);
   if(bucket)bucket.push(i);else buckets.set(id,[i]);
  }
 }
 return{
  segmentCount:valid.length,
  find:(x,y,tolerance)=>{
   if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(tolerance)||tolerance<=0)return null;
   const col=cellAt(x,minX),row=cellAt(y,minY);
   const range=Math.min(30,Math.ceil(tolerance/cell)+1);
   const candidates=new Set(longSegments);
   for(let dx=-range;dx<=range;dx++)for(let dy=-range;dy<=range;dy++){
    for(const i of buckets.get(key(col+dx,row+dy))??[])candidates.add(i);
   }
   let best:DrawingSnap|null=null;
   let bestScore=tolerance;
   const consider=(px:number,py:number,kind:DrawingSnap["kind"])=>{
    const distance=Math.hypot(x-px,y-py);
    // Slightly prefer exact vertices when several nearby snaps compete.
    const score=distance-(kind==="endpoint"?tolerance*.25:kind==="midpoint"?tolerance*.15:0);
    if(distance<=tolerance&&score<bestScore){
     best={x:px,y:py,kind,distance};bestScore=score;
    }
   };
   for(const i of candidates){
    const s=valid[i]!;
    const vx=s.x2-s.x1,vy=s.y2-s.y1,len2=vx*vx+vy*vy;
    consider(s.x1,s.y1,"endpoint");
    consider(s.x2,s.y2,"endpoint");
    consider((s.x1+s.x2)/2,(s.y1+s.y2)/2,"midpoint");
    if(len2>0){
     const t=Math.max(0,Math.min(1,((x-s.x1)*vx+(y-s.y1)*vy)/len2));
     consider(s.x1+vx*t,s.y1+vy*t,"nearest");
    }
   }
   return best;
  },
 };
}
