/** Restrained approximation when a DXF DIMENSION representation BLOCK is absent.
 * Supported: rotated linear (type 0), aligned linear (type 1) in XY.
 * Never silently infer angular/radial/tolerance/ordinate geometry.
 */
export type DimensionPair={code:number;value:string};
export type DimensionStyle={
 scale:number;arrowSize:number;extensionOffset:number;extensionBeyond:number;
 textHeight:number;textGap:number;decimals:number;linearFactor:number;
 rounding:number;tolerance:boolean;
};
export type Point2={x:number;y:number};
export type DimensionFallback={
 segments:[Point2,Point2][];
 label:{text:string;point:Point2;height:number;rotation:number}|null;
 measured:number;
 error?:never;
};
export type DimensionAttempt=DimensionFallback|{error:string};
export const DEFAULT_DIM_STYLE:DimensionStyle={
 scale:1,arrowSize:2.5,extensionOffset:.625,extensionBeyond:1.25,
 textHeight:2.5,textGap:.625,decimals:2,linearFactor:1,rounding:0,
 tolerance:false,
};
const scalar=(records:readonly DimensionPair[],code:number):number|null=>{
 const record=records.find(pair=>pair.code===code);
 if(!record)return null;
 const value=Number(record.value);
 return Number.isFinite(value)?value:null;
};
export function parseDimensionStyle(records:readonly DimensionPair[],base:DimensionStyle=DEFAULT_DIM_STYLE):DimensionStyle{
 const setting=(code:number,fallback:number)=>scalar(records,code)??fallback;
 return {
  scale:setting(40,base.scale),arrowSize:setting(41,base.arrowSize),
  extensionOffset:setting(42,base.extensionOffset),
  extensionBeyond:setting(44,base.extensionBeyond),
  textHeight:setting(140,base.textHeight),
  textGap:setting(147,base.textGap),decimals:setting(271,base.decimals),
  linearFactor:setting(144,base.linearFactor),rounding:setting(45,base.rounding),
  tolerance:(scalar(records,71)??(base.tolerance?1:0))!==0||
   (scalar(records,72)??0)!==0,
 };
}
function textValue(value:number,decimals:number,rounding:number,override:string):string{
 const scaled=rounding>0?Math.round(value/rounding)*rounding:value;
 const measurement=scaled.toFixed(decimals);
 if(override===" ")return"";
 if(!override||override==="<>")return measurement;
 return override.replace(/<>/g,measurement);
}
/** Produce only geometry that can be reconstructed from documented DXF fields. */
export function buildDimensionFallback(
 records:readonly DimensionPair[],style:DimensionStyle=DEFAULT_DIM_STYLE,
):DimensionAttempt{
 const first=(code:number)=>records.find(pair=>pair.code===code)?.value;
 const dimensionType=scalar(records,70);
 if(dimensionType===null)return{error:"缺少尺寸类型"};
 const type=dimensionType&7;
 if(type!==0&&type!==1)return{error:"角度、半径、直径或坐标尺寸无安全回退"};
 if(style.tolerance)return{error:"公差与极限尺寸要求原始图形表示"};
 if((scalar(records,70)??0)&128)return{error:"用户自定义文字位置要求原始图形表示"};
 if(records.some(pair=>pair.code===210&&Number(pair.value)!==0||
  pair.code===220&&Number(pair.value)!==0||
  pair.code===230&&Number(pair.value)!==1))return{error:"非 XY 标注平面不支持"};
 const point=(xCode:number,yCode:number):Point2|null=>{
  const x=scalar(records,xCode),y=scalar(records,yCode);
  return x===null||y===null?null:{x,y};
 };
 const a=point(13,23),b=point(14,24),linePoint=point(10,20);
 if(!a||!b||!linePoint)return{error:"尺寸界线定义点不足"};
 const dx=b.x-a.x,dy=b.y-a.y,span=Math.hypot(dx,dy);
 if(span<1e-8||!Number.isFinite(span))return{error:"尺寸界线距离退化"};
 let ux=dx/span,uy=dy/span;
 if(type===0){
  const angle=scalar(records,50);
  if(angle===null)return{error:"旋转线性尺寸缺少角度"};
  ux=Math.cos(angle*Math.PI/180);uy=Math.sin(angle*Math.PI/180);
 }
 const nx=-uy,ny=ux;
 const projected=Math.abs(dx*ux+dy*uy);
 if(projected<1e-8)return{error:"尺寸投影长度退化"};
 const values=[style.scale,style.arrowSize,style.extensionOffset,
  style.extensionBeyond,style.textHeight,style.textGap,style.decimals,
  style.linearFactor,style.rounding];
 if(values.some(n=>!Number.isFinite(n))||style.scale<=0||style.scale>1e5||
  style.arrowSize<=0||style.arrowSize>1e5||
  style.extensionOffset<0||style.extensionBeyond<0||
  style.textHeight<=0||style.textHeight>1e5||
  style.textGap<0||style.linearFactor<=0||style.rounding<0||
  !Number.isInteger(style.decimals)||style.decimals<0||style.decimals>8)
  return{error:"尺寸样式参数无效或超限"};
 const scale=style.scale;
 const signed=(linePoint.x-a.x)*nx+(linePoint.y-a.y)*ny;
 const displacement=Math.abs(signed),side=signed<0?-1:1;
 if(displacement<1e-8)return{error:"尺寸线与界线起点重合"};
 const p1={x:a.x+nx*signed,y:a.y+ny*signed};
 const p2={x:b.x+nx*((linePoint.x-b.x)*nx+(linePoint.y-b.y)*ny),
  y:b.y+ny*((linePoint.x-b.x)*nx+(linePoint.y-b.y)*ny)};
 const exo=style.extensionOffset*scale,exe=style.extensionBeyond*scale;
 const arrow=Math.min(style.arrowSize*scale,projected*.25);
 const segments:[Point2,Point2][]=[];
 const shift=(p:Point2,normal:number,along=0):Point2=>({
  x:p.x+nx*normal+ux*along,y:p.y+ny*normal+uy*along,
 });
 segments.push([p1,p2]);
 if(displacement>exo){
  segments.push([shift(a,side*exo),shift(p1,side*exe)]);
  segments.push([shift(b,side*exo),shift(p2,side*exe)]);
 }
 for(const [tip,dir] of [[p1,1],[p2,-1]] as const){
  const depth=arrow*.3;
  segments.push([tip,shift(tip,depth,arrow*dir)]);
  segments.push([tip,shift(tip,-depth,arrow*dir)]);
 }
 const value=projected*style.linearFactor;
 const override=first(1)??"";
 const text=textValue(value,style.decimals,style.rounding,override).slice(0,200);
 const specified=point(11,21);
 const mid={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2};
 const label=text?{text,point:specified??shift(mid,side*(style.textGap+style.textHeight*.7)*scale),
  height:style.textHeight*scale,rotation:Math.atan2(uy,ux)*180/Math.PI}:null;
 if(segments.some(([v,w])=>![v.x,v.y,w.x,w.y].every(n=>Number.isFinite(n)&&Math.abs(n)<1e12)))
  return{error:"尺寸结果超出安全范围"};
 return{segments,label,measured:value};
}
