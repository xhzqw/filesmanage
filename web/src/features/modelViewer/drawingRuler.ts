/** Source-coordinate SVG rulers for the orthographic XY drawing canvas.
 * This display overlay does not modify or export source DXF geometry.
 */
export type DrawingBounds={left:number;right:number;top:number;bottom:number};
export type DrawingCoordinate={x:number;y:number};
const niceStep=(target:number)=>{
 const unit=10**Math.floor(Math.log10(Math.max(target,1e-12)));
 const factor=target/unit;
 return (factor<=1?1:factor<=2?2:factor<=5?5:10)*unit;
};
const label=(v:number)=>Number((Math.abs(v)<1e-10?0:v).toPrecision(6)).toLocaleString("en-US",{maximumFractionDigits:6});
export function mountDrawingRuler(holder:HTMLElement){
 const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
 svg.classList.add("cad-coordinate-ruler");
 svg.setAttribute("aria-hidden","true");
 holder.appendChild(svg);
 let previous="";
 const update=(bounds:DrawingBounds,grid:boolean,hover:DrawingCoordinate|null)=>{
  const w=holder.clientWidth,h=holder.clientHeight;
  if(w<100||h<60||bounds.right<=bounds.left||bounds.top<=bounds.bottom||
    !Object.values(bounds).every(Number.isFinite))return;
  const unit=(bounds.right-bounds.left)/w,step=niceStep(unit*90);
  const left=Math.ceil(bounds.left/step),right=Math.floor(bounds.right/step);
  const low=Math.ceil(bounds.bottom/step),high=Math.floor(bounds.top/step);
  const key=[w,h,bounds.left.toPrecision(9),bounds.top.toPrecision(9),unit.toPrecision(9),
   grid,hover?label(hover.x):"",hover?label(hover.y):""].join(":");
  if(previous===key)return;
  previous=key;
  svg.setAttribute("viewBox","0 0 "+w+" "+h);
  const x=(value:number)=>Number(((value-bounds.left)/unit).toFixed(2));
  const y=(value:number)=>Number(((bounds.top-value)/unit).toFixed(2));
  const light:string[]=[],strong:string[]=[],ticks:string[]=[];
  for(let k=0;k<Math.min(110,Math.max(0,right-left+1));k++){
   const index=left+k,px=x(index*step);
   (index%5===0?strong:light).push("M"+px+" 0V"+(h-25));
   if(index%2===0&&px>56&&px<w-40)
    ticks.push('<text x="'+px+'" y="'+(h-8)+'" text-anchor="middle">'+label(index*step)+'</text>');
  }
  for(let k=0;k<Math.min(110,Math.max(0,high-low+1));k++){
   const index=low+k,py=y(index*step);
   (index%5===0?strong:light).push("M48 "+py+"H"+w);
   if(index%2===0&&py>42&&py<h-29)
    ticks.push('<text x="43" y="'+(py+3)+'" text-anchor="end">'+label(index*step)+'</text>');
  }
  const x0=x(0),y0=y(0);
  const origin=(x0>=48&&x0<=w?"M"+x0+" 0V"+(h-25)+" ":"")+
   (y0>=0&&y0<=h-25?"M48 "+y0+"H"+w:"");
  const pointer=hover??{x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
  const text="X "+label(pointer.x)+"  Y "+label(pointer.y);
  svg.innerHTML=
   (grid?'<path d="'+light.join(" ")+'" fill="none" stroke="#ecf0f3" stroke-width=".7"/>'+
    '<path d="'+strong.join(" ")+'" fill="none" stroke="#d5dfe7" stroke-width=".9"/>'+
    '<path d="'+origin+'" fill="none" stroke="#8da5b8" stroke-width="1.15"/>':"")+
   '<rect x="0" y="'+(h-25)+'" width="'+w+'" height="25" fill="#f7f9fc"/>'+
   '<rect x="0" y="0" width="48" height="'+h+'" fill="#f7f9fc"/>'+
   '<path d="M48 0V'+(h-25)+'H'+w+'" fill="none" stroke="#bccbd7" stroke-width="1"/>'+
   '<g fill="#445a6f" font-size="10" font-weight="500" font-family="system-ui,sans-serif">'+
   ticks.join("")+'<text x="10" y="'+(h-8)+'" font-weight="700">XY</text></g>'+
   '<rect x="'+Math.max(52,w-250)+'" y="'+(h-25)+'" width="'+Math.min(250,w-52)+'" height="25" fill="#e9f1f7"/>'+
   '<text x="'+(w-10)+'" y="'+(h-8)+'" fill="#22384c" font-size="11" font-weight="600" text-anchor="end" font-family="monospace">'+text+'</text>';
 };
 return {update,dispose:()=>svg.remove()};
}
