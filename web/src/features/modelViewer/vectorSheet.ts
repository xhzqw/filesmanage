import type * as Three from "three";
import type {SheetSize} from "./printSheet";

export type PlotScale=1|2|5|10;
export type PlotOptions={sheet:SheetSize;scale:PlotScale;unit:string;layout:string;marginMm?:number};
export type PlotSheet={html:string;svg:string;drawingMm:[number,number];scaleLabel:string};

const SHEETS:Record<SheetSize,[number,number]>={A3:[420,297],A4:[297,210]};
const MAX_SEGMENTS=100000,MAX_FACES=50000,MAX_LABELS=400,MAX_BYTES=15_000_000;
const esc=(value:string)=>value.replace(/[&<>"']/g,ch=>({
 "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
}[ch]??ch));
const fmt=(number:number)=>Number(number.toFixed(5)).toString();
type Graphic=
 |{kind:"segment";layer:string;hex:string;from:[number,number];to:[number,number]}
 |{kind:"triangle";layer:string;hex:string;alpha:number;points:[number,number][]}
 |{kind:"glyph";layer:string;center:[number,number];size:[number,number];
    degrees:number;png:string};

/** Millimetre-coordinate SVG print for existing visible DXF paper layers.
 *
 * Only explicit DXF mm is trusted. Coordinates are mapped 1:1/N to a
 * physically sized SVG; NEVER use an implicit fit-to-page transform.
 * The printer dialog must remain at 100% / actual size for paper accuracy.
 * Three geometry is already expanded to model/paper coordinates by parseDxf.
 */
export function buildVectorSheet(root:Three.Group,options:PlotOptions):PlotSheet{
 if(options.unit!=="mm")throw new Error("比例出图仅支持明确声明毫米单位的 DXF");
 if(options.layout==="Model")throw new Error("请切换至图纸布局后再按比例打印");
 const paper=SHEETS[options.sheet];
 if(!paper||![1,2,5,10].includes(options.scale))throw new Error("纸张或比例不支持");
 const margin=options.marginMm??10;
 if(!Number.isFinite(margin)||margin<5||margin>25)
  throw new Error("图纸边距无效");
 const shapes:Graphic[]=[];
 let segments=0,faces=0,labels=0;
 const include=(x:number,y:number)=>{
  if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1e10||Math.abs(y)>1e10)
   throw new Error("包含越界或非有限的图纸坐标");
 };
 const color=(material:Three.Material):string=>{
  const value=(material as Three.MeshBasicMaterial).color;
  return value?.isColor?"#"+value.getHexString():"#253b53";
 };
 // Rendering moves the original root to its fit-to-screen center; children
 // keep their unmodified DXF coordinates. Never apply root.matrixWorld here.
 for(const group of root.children){
  if(!group.visible)continue;
  const layer=String(group.userData.layer??group.name);
  for(const child of group.children){
   if(!child.visible)continue;
   const material=(child as Three.Mesh).material as Three.Material|undefined;
   if(!material)throw new Error("包含未能转换的图纸对象");
   const line=child as Three.LineSegments;
   if(line.isLineSegments){
    const positions=line.geometry.getAttribute("position");
    if(!positions||positions.count%2!==0)throw new Error("线段坐标不完整");
    segments+=positions.count/2;
    if(segments>MAX_SEGMENTS)throw new Error("图纸线段数量超出矢量打印预算");
    const hex=color(material);
    for(let i=0;i<positions.count;i+=2){
     const a:[number,number]=[positions.getX(i),positions.getY(i)];
     const b:[number,number]=[positions.getX(i+1),positions.getY(i+1)];
     include(...a);include(...b);
     shapes.push({kind:"segment",layer,hex,from:a,to:b});
    }
    continue;
   }
   const mesh=child as Three.Mesh;
   if(mesh.isMesh&&(mesh.name==="HATCH"||mesh.name==="VIEWPORT_HATCH")){
    const attr=mesh.geometry.getAttribute("position");
    if(!attr||attr.count%3!==0)throw new Error("填充三角形不完整");
    faces+=attr.count/3;
    if(faces>MAX_FACES)throw new Error("填充三角形数量超出矢量打印预算");
    const hex=color(material),alpha=(material as Three.MeshBasicMaterial).opacity??1;
    for(let i=0;i<attr.count;i+=3){
     const tri:[number,number][]=[];
     for(let j=0;j<3;j++){
      const point:[number,number]=[attr.getX(i+j),attr.getY(i+j)];
      include(...point);tri.push(point);
     }
     shapes.push({kind:"triangle",layer,hex,alpha,points:tri});
    }
    continue;
   }
   // Texture-backed engineering text is an approximation of the CAD font.
   // Do not silently strip it from a dimensioned paper drawing.
   const sprite=child as Three.Sprite;
   const isText=Boolean(sprite.isSprite)||mesh.name==="VIEWPORT_TEXT";
   if(isText){
    labels++;
    if(labels>MAX_LABELS)throw new Error("文字标注超出矢量打印预算");
    if(mesh.name==="VIEWPORT_TEXT")throw new Error("当前视口内存在已裁切文字，请使用图像打印");
    const source=(material as Three.SpriteMaterial).map?.image as HTMLCanvasElement|undefined;
    if(!source||typeof source.toDataURL!=="function")
     throw new Error("当前浏览器无法导出文字贴图");
    const png=source.toDataURL("image/png");
    if(!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(png))
     throw new Error("无法读取文字贴图");
    include(sprite.position.x,sprite.position.y);
    if(![sprite.scale.x,sprite.scale.y].every(n=>Number.isFinite(n)&&n>0))
     throw new Error("文字标注比例不完整");
    shapes.push({kind:"glyph",layer,center:[sprite.position.x,sprite.position.y],
     size:[sprite.scale.x,sprite.scale.y],
     degrees:(material as Three.SpriteMaterial).rotation*180/Math.PI,png});
    continue;
   }
   throw new Error("当前图纸存在尚不支持的矢量打印对象");
  }
 }
 if(!shapes.length)throw new Error("当前可见图层没有可打印的图形");
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 const push=(x:number,y:number)=>{
  minX=Math.min(minX,x);maxX=Math.max(maxX,x);
  minY=Math.min(minY,y);maxY=Math.max(maxY,y);
 };
 for(const shape of shapes){
  if(shape.kind==="segment"){push(...shape.from);push(...shape.to);}
  else if(shape.kind==="triangle")shape.points.forEach(p=>push(...p));
  else{
   const [x,y]=shape.center,[w,h]=shape.size;
   const c=Math.cos(shape.degrees*Math.PI/180),s=Math.sin(shape.degrees*Math.PI/180);
   for(const a of [-w/2,w/2])for(const b of [-h/2,h/2])
    push(x+c*a-s*b,y+s*a+c*b);
  }
 }
 const drawingMm:[number,number]=[(maxX-minX)/options.scale,(maxY-minY)/options.scale];
 if(drawingMm[0]>paper[0]-2*margin+1e-6||drawingMm[1]>paper[1]-2*margin+1e-6)
  throw new Error("当前图纸按 1:"+options.scale+" 打印超出"+options.sheet+"可打印范围；请选择更大纸张或更小比例");
 const x=(value:number)=>fmt(margin+(value-minX)/options.scale);
 const y=(value:number)=>fmt(paper[1]-margin-(value-minY)/options.scale);
 const svgNodes=shapes.map(shape=>{
  if(shape.kind==="segment"){
   return '<line x1="'+x(shape.from[0])+'" y1="'+y(shape.from[1])+
    '" x2="'+x(shape.to[0])+'" y2="'+y(shape.to[1])+
    '" stroke="'+shape.hex+'" stroke-width="0.18"/>';
  }
  if(shape.kind==="triangle")return '<polygon points="'+shape.points.map(p=>x(p[0])+','+y(p[1])).join(' ')+
   '" fill="'+shape.hex+'" fill-opacity="'+fmt(shape.alpha)+'"/>';
  const [cx,cy]=shape.center,[w,h]=shape.size;
  return '<image href="'+shape.png+'" x="'+x(cx-w/2)+'" y="'+y(cy+h/2)+
   '" width="'+fmt(w/options.scale)+'" height="'+fmt(h/options.scale)+
   '" transform="rotate('+fmt(-shape.degrees)+' '+x(cx)+' '+y(cy)+')"/>';
 });
 const svg='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'+
  ' viewBox="0 0 '+paper.join(' ')+'" width="'+paper[0]+'mm" height="'+paper[1]+
  'mm" aria-label="'+esc(options.layout)+' 矢量图纸">'+
  '<rect x="0" y="0" width="'+paper[0]+'" height="'+paper[1]+'" fill="#fff"/>'+
  '<rect x="'+margin+'" y="'+margin+'" width="'+(paper[0]-2*margin)+
  '" height="'+(paper[1]-2*margin)+'" fill="none" stroke="#9daebc" stroke-width="0.15"/>'+
  svgNodes.join("")+'</svg>';
 if(svg.length>MAX_BYTES)throw new Error("图纸矢量内容超过输出限制");
 const title=esc(options.layout.slice(0,100));
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
  '<title>'+title+' · '+options.sheet+' 1:'+options.scale+'</title><style>'+
  '@page{size:'+options.sheet+' landscape;margin:0}html,body{margin:0;padding:0}'+
  'svg{display:block;width:'+paper[0]+'mm;height:'+paper[1]+'mm}'+
  '.notice{font:13px system-ui,sans-serif;padding:12px;color:#334b63}'+
  '@media print{.notice{display:none}}@media screen{body{background:#e8eef4}svg{background:#fff;'+
  'margin:16px auto;box-shadow:0 6px 30px #0002}}'+
  '</style></head><body><div class="notice">图纸比例 1:'+options.scale+
  ' · 请在打印设置中选择“实际大小 / 100%”，关闭“适合页面”。浏览器及打印机仍可能引入误差；字形为预览近似。</div>'+
  svg+'</body></html>';
 return{html,svg,drawingMm,scaleLabel:"1:"+options.scale};
}

export function openVectorPrint(root:Three.Group,options:PlotOptions,opened?:Window):void{
 const result=buildVectorSheet(root,options);
 const popup=opened??window.open("","_blank");
 if(!popup)throw new Error("浏览器阻止了打印预览弹窗");
 popup.document.open();
 popup.document.write(result.html);
 popup.document.close();
 popup.focus();
 // User manually confirms scale and printing. Never auto-print before review.
}
