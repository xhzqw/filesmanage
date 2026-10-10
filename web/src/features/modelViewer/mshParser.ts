// Gmsh MSH 2.2 ASCII, pure CPU geometry pipeline. Runs in mshWorker.
// No Three.js, DOM or React imports: dense node indices and typed arrays
// avoid per-triangle objects while the worker keeps parsing off the UI thread.
export const MAX_MSH_TRIANGLES=2_000_000;
const MAX_MSH_NODES=3_000_000;
const MAX_MSH_ELEMENTS=6_000_000;

export type MeshBufferPart={
 positions:Float32Array;
 normals:Float32Array;
 bounds:[number,number,number,number,number,number];
 triangles:number;
};
export type MshGeometry={parts:MeshBufferPart[];triangleCount:number};

export class MshLimitError extends Error{}

export function parseMshAssembly(bytes:ArrayBuffer):MshGeometry{
 const source=new TextDecoder("utf-8",{fatal:false}).decode(bytes);
 if(!/\$MeshFormat\s*\r?\n2\.2\s+0\s+8\s*\r?\n/.test(source)){
  throw Error("仅支持 Gmsh 2.2 ASCII 网格");
 }
 const startSection=(label:string):{start:number;end:number}=>{
  const key="$"+label+"\n",crKey="$"+label+"\r\n";
  let start=source.indexOf(key);
  let size=key.length;
  if(start<0){start=source.indexOf(crKey);size=crKey.length;}
  const end=source.indexOf("$End"+label,start<0?0:start+size);
  if(start<0||end<0)throw Error("不完整的 MSH "+label+" 数据段");
  return {start:start+size,end};
 };
 let offset=0;
 const nextLine=(end:number):string=>{
  if(offset>=end)throw Error("MSH 数据行数不足");
  let next=source.indexOf("\n",offset);
  if(next<0||next>end)next=end;
  const line=source.slice(offset,next).trim();
  offset=next+1;
  return line;
 };
 const count=(text:string,max:number):number=>{
  const value=Number(text);
  if(!Number.isSafeInteger(value)||value<0||value>max){
   throw new MshLimitError("MSH 节点或网格复杂度超过预览限制");
  }
  return value;
 };
 const section=startSection("Nodes");
 offset=section.start;
 const nodeCount=count(nextLine(section.end),MAX_MSH_NODES);
 const nodeMap=new Map<number,number>();
 const coordinates=new Float64Array(nodeCount*3);
 for(let i=0;i<nodeCount;i++){
  const fields=nextLine(section.end).split(/\s+/);
  if(fields.length!==4)throw Error("无效的 MSH 节点坐标");
  const id=Number(fields[0]);
  const x=Number(fields[1]),y=Number(fields[2]),z=Number(fields[3]);
  if(!Number.isSafeInteger(id)||id<=0||nodeMap.has(id)||
     ![x,y,z].every(Number.isFinite))throw Error("无效的 MSH 节点");
  nodeMap.set(id,i);
  const k=i*3;
  coordinates[k]=x;coordinates[k+1]=y;coordinates[k+2]=z;
 }
 const elements=startSection("Elements");
 offset=elements.start;
 const elementCount=count(nextLine(elements.end),MAX_MSH_ELEMENTS);
 const parent=new Uint32Array(nodeCount);
 const weight=new Uint32Array(nodeCount);
 for(let i=0;i<nodeCount;i++){parent[i]=i;weight[i]=1;}
 const find=(n:number):number=>{
  while(parent[n]!==n){
   parent[n]=parent[parent[n]];
   n=parent[n];
  }
  return n;
 };
 const union=(a:number,b:number):void=>{
  let ra=find(a),rb=find(b);
  if(ra===rb)return;
  if(weight[ra]<weight[rb]){const temp=ra;ra=rb;rb=temp;}
  parent[rb]=ra;weight[ra]+=weight[rb];
 };
 let triangles=new Uint32Array(Math.min(8192,MAX_MSH_TRIANGLES)*3);
 let triangleCount=0;
 for(let i=0;i<elementCount;i++){
  const row=nextLine(elements.end);
  // Only triangle elements are relevant; element records include an arbitrary
  // number of physical/group tags before exactly three node IDs.
  const values=row.split(/\s+/);
  if(values[1]!=="2")continue;
  const tagCount=Number(values[2]);
  if(!Number.isSafeInteger(tagCount)||tagCount<0||
     values.length!==3+tagCount+3)throw Error("无效的 MSH 三角形记录");
  const a=nodeMap.get(Number(values[3+tagCount]));
  const b=nodeMap.get(Number(values[4+tagCount]));
  const c=nodeMap.get(Number(values[5+tagCount]));
  if(a===undefined||b===undefined||c===undefined)continue;
  if(triangleCount>=MAX_MSH_TRIANGLES)throw new MshLimitError("三角形数量超过在线预览限制");
  if(triangleCount*3>=triangles.length){
   const next=new Uint32Array(Math.min(triangles.length*2,MAX_MSH_TRIANGLES*3));
   next.set(triangles);triangles=next;
  }
  const k=triangleCount*3;
  triangles[k]=a;triangles[k+1]=b;triangles[k+2]=c;
  triangleCount++;
  union(a,b);union(b,c);
 }
 // Count connected triangles first so each part gets exactly one allocation.
 const partsByRoot=new Map<number,{root:number;count:number;first:number}>();
 for(let i=0;i<triangleCount;i++){
  const root=find(triangles[i*3]);
  const entry=partsByRoot.get(root);
  if(entry)entry.count++;
  else partsByRoot.set(root,{root,count:1,first:i});
 }
 const ordered=[...partsByRoot.values()].sort((a,b)=>b.count-a.count||a.first-b.first);
 const parts:MeshBufferPart[]=ordered.map(p=>({
  positions:new Float32Array(p.count*9),
  normals:new Float32Array(p.count*9),
  triangles:p.count,
  bounds:[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],
 }));
 const locations=new Map<number,number>();
 for(let i=0;i<ordered.length;i++)locations.set(ordered[i].root,i);
 const offsets=new Uint32Array(parts.length);
 for(let i=0;i<triangleCount;i++){
  const k=i*3;
  const part=parts[locations.get(find(triangles[k]))!];
  const base=offsets[locations.get(find(triangles[k]))!] *9;
  offsets[locations.get(find(triangles[k]))!]++;
  for(let vertex=0;vertex<3;vertex++){
   const src=triangles[k+vertex]*3;
   for(let axis=0;axis<3;axis++){
    const value=coordinates[src+axis];
    const cast=Math.fround(value);
    part.positions[base+vertex*3+axis]=cast;
    if(cast<part.bounds[axis])part.bounds[axis]=cast;
    if(cast>part.bounds[axis+3])part.bounds[axis+3]=cast;
   }
  }
  // Non-indexed triangles use flat normals. Calculate on the worker, rather
  // than blocking a React frame in BufferGeometry.computeVertexNormals().
  const p=part.positions;
  const ax=p[base],ay=p[base+1],az=p[base+2];
  const ux=p[base+3]-ax,uy=p[base+4]-ay,uz=p[base+5]-az;
  const vx=p[base+6]-ax,vy=p[base+7]-ay,vz=p[base+8]-az;
  let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
  const magnitude=Math.hypot(nx,ny,nz);
  if(magnitude>0){nx/=magnitude;ny/=magnitude;nz/=magnitude;}
  for(let vertex=0;vertex<3;vertex++){
   part.normals[base+vertex*3]=nx;
   part.normals[base+vertex*3+1]=ny;
   part.normals[base+vertex*3+2]=nz;
  }
 }
 return {parts,triangleCount};
}
