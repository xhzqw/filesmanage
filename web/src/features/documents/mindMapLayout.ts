import type {XMindTopic} from "../../entities/file/model";

export type MindMapDirection="balanced"|"right";
export type MindMapNode={path:string;topic:XMindTopic;depth:number;x:number;y:number;children:number};
export type MindMapEdge={key:string;fromX:number;fromY:number;toX:number;toY:number;kind:string};
export type IndexedMindTopic={path:string;topic:XMindTopic;depth:number};
export const MIND_NODE_WIDTH=204;
export const MIND_NODE_HEIGHT=54;
const COLUMN_GAP=88;
const ROW_GAP=20;
const PADDING=56;
const STEP=MIND_NODE_WIDTH+COLUMN_GAP;

export function indexMindMap(root:XMindTopic):IndexedMindTopic[]{
 const result:IndexedMindTopic[]=[];
 function walk(topic:XMindTopic,path:string,depth:number){
  result.push({path,topic,depth});
  topic.children?.forEach((child,i)=>walk(child,path+"."+i,depth+1));
 }
 walk(root,"0",0);
 return result;
}

// Server-bounded nodes plus viewport culling keep rendering bounded.
// The layout engine is deterministic and pure, so tests can verify that
// every visible node/edge fits the canvas and that subtrees never overlap.
export function layoutMindMap(root:XMindTopic,folded:ReadonlySet<string>,direction:MindMapDirection){
 const heights=new Map<string,number>();
 function measure(topic:XMindTopic,path:string):number{
  const children=folded.has(path)?[]:topic.children??[];
  let total=0;
  children.forEach((child,i)=>{
   total+=measure(child,path+"."+i);
   if(i>0)total+=ROW_GAP;
  });
  const height=Math.max(MIND_NODE_HEIGHT,total);
  heights.set(path,height);
  return height;
 }
 measure(root,"0");
 const left:{topic:XMindTopic;path:string;height:number}[]=[];
 const right:{topic:XMindTopic;path:string;height:number}[]=[];
 let lWeight=0,rWeight=0;
 const allChildren=folded.has("0")?[]:root.children??[];
 allChildren.forEach((topic,i)=>{
  const path="0."+i,height=heights.get(path)??MIND_NODE_HEIGHT;
  const chooseRight=direction==="right"||rWeight<=lWeight;
  (chooseRight?right:left).push({topic,path,height});
  if(chooseRight)rWeight+=height+ROW_GAP;else lWeight+=height+ROW_GAP;
 });
 const stackHeight=(items:{height:number}[])=>items.reduce((sum,item,i)=>sum+item.height+(i?ROW_GAP:0),0);
 const leftHeight=stackHeight(left),rightHeight=stackHeight(right);
 const visibleHeight=Math.max(MIND_NODE_HEIGHT,leftHeight,rightHeight);
 const center=visibleHeight/2+PADDING;
 const nodes:MindMapNode[]=[{path:"0",topic:root,depth:0,x:0,y:center-MIND_NODE_HEIGHT/2,children:root.children?.length??0}];
 const edges:MindMapEdge[]=[];
 function place(topic:XMindTopic,path:string,depth:number,side:1|-1,top:number,parent:MindMapNode){
  const branchHeight=heights.get(path)??MIND_NODE_HEIGHT;
  const y=top+(branchHeight-MIND_NODE_HEIGHT)/2;
  const x=side*depth*STEP;
  const node={path,topic,depth,x,y,children:topic.children?.length??0};
  nodes.push(node);
  edges.push({key:path,fromX:side===1?parent.x+MIND_NODE_WIDTH:parent.x,
   fromY:parent.y+MIND_NODE_HEIGHT/2,toX:side===1?x:x+MIND_NODE_WIDTH,
   toY:y+MIND_NODE_HEIGHT/2,kind:topic.kind??""});
  if(folded.has(path))return;
  let nextTop=top;
  topic.children?.forEach((child,i)=>{
   if(i>0)nextTop+=ROW_GAP;
   const childPath=path+"."+i;
   place(child,childPath,depth+1,side,nextTop,node);
   nextTop+=heights.get(childPath)??MIND_NODE_HEIGHT;
  });
 }
 for(const [group,side] of [[right,1],[left,-1]] as const){
  let cursor=PADDING+(visibleHeight-stackHeight(group))/2;
  for(const item of group){
   place(item.topic,item.path,1,side,cursor,nodes[0]);
   cursor+=item.height+ROW_GAP;
  }
 }
 const minX=Math.min(...nodes.map(n=>n.x)),maxX=Math.max(...nodes.map(n=>n.x+MIND_NODE_WIDTH));
 const offset=PADDING-minX;
 nodes.forEach(n=>{n.x+=offset;});
 edges.forEach(e=>{e.fromX+=offset;e.toX+=offset;});
 return {nodes,edges,width:maxX-minX+PADDING*2,height:visibleHeight+PADDING*2};
}
