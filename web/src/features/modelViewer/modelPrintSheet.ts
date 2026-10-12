import type {EngineeringPrintViews,ViewerMetrics} from "./viewerScene";
import type {SheetSize} from "./printSheet";

export type ModelPrintData={
 name:string;
 versionSeq:number;
 sha256:string;
 unit:string;
 format:string;
 metrics:ViewerMetrics;
 views:EngineeringPrintViews;
 paper:SheetSize;
};

const escapeText=(value:string)=>value.replace(/[&<>"']/g,ch=>({
 "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
}[ch]??ch));
const formatDim=(v:number)=>Number.isFinite(v)&&v>=0?Number(v.toPrecision(6)).toLocaleString("zh-CN"):"—";
const sheets:Record<SheetSize,[number,number]>={A4:[297,210],A3:[420,297],A2:[594,420],A1:[841,594]};

// Print reference orthographic projections of tessellated geometry. No
// implied CAD tolerances or guaranteed manufacturing dimensions.
export function modelPrintSheetHtml(input:ModelPrintData):string{
 const dims=input.metrics.size;
 if(dims.length!==3||dims.some(v=>!Number.isFinite(v)||v<0))
  throw new Error("无法读取模型的几何尺寸");
 const paper=sheets[input.paper];
 if(!paper)throw new Error("纸张类型不支持");
 const cards=([
  ["front","主视图 · Front"],["top","俯视图 · Top"],
  ["right","右视图 · Right"],["iso","等轴测 · ISO"],
 ] as const).map(([kind,title])=>{
  const src=input.views[kind];
  if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(src)||src.length>12_000_000)
   throw new Error("工程视图包含无效截图");
  return '<figure><div class="view"><img alt="'+escapeText(title)+'" src="'+src+
   '"></div><figcaption>'+escapeText(title)+'</figcaption></figure>';
 }).join("");
 const actualUnit=input.unit==="unknown"||!input.unit.trim()?"未声明（不作为制造尺寸）":escapeText(input.unit);
 const description=dims.map(formatDim).join(" × ");
 const file=escapeText(input.name.slice(0,200));
 const shortHash=escapeText(input.sha256.slice(0,16));
 return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
  '<title>'+file+' · 工程视图</title><style>'+
  '@page{size:'+paper[0]+'mm '+paper[1]+'mm;margin:0}'+
  '*{box-sizing:border-box}html,body{margin:0;color:#142638;background:white;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif}'+
  '.sheet{width:'+paper[0]+'mm;height:'+paper[1]+'mm;padding:9mm;display:flex;flex-direction:column;gap:4mm;break-after:page}'+
  'header{display:flex;align-items:baseline;justify-content:space-between;gap:8mm;border-bottom:1px solid #657687;padding-bottom:2mm}'+
  'header strong{font-size:15px;max-width:75%;overflow-wrap:anywhere}'+
  '.views{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:4mm;flex:1;min-height:0}'+
  'figure{margin:0;min-height:0;display:flex;flex-direction:column;border:1px solid #b6c2cc}'+
  '.view{flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center}'+
  'img{display:block;object-fit:contain;max-width:100%;max-height:100%}'+
  'figcaption{border-top:1px solid #b6c2cc;background:#f5f7fa;padding:1.3mm 2mm;font-size:11px}'+
  'footer{display:flex;justify-content:space-between;gap:5mm;border-top:1px solid #657687;padding-top:2mm;font-size:10px}'+
  '.warn{color:#87491f}.controls{font:13px system-ui;padding:10px 16px;background:#e9eff5;color:#142638;display:flex;gap:15px;align-items:center}'+
  '.controls button{font:inherit;background:#174098;border:0;border-radius:7px;color:white;padding:7px 17px;cursor:pointer}'+
  '@media screen{body{background:#dfe6ed}.sheet{margin:14px auto;background:white;box-shadow:0 5px 30px #10203030}}'+
  '@media print{.controls{display:none}figure{break-inside:avoid}}'+
  '</style></head><body><div class="controls"><button id="print-now" type="button">打印本页</button>'+
  '<span>参考工程视图 · 不代表带公差的制造图纸</span></div>'+
  '<main class="sheet"><header><strong>'+file+'</strong><span>'+escapeText(input.format.toUpperCase())+
  ' · v'+input.versionSeq+'</span></header>'+
  '<div class="views">'+cards+'</div>'+
  '<footer><span>模型外包络 X × Y × Z：'+description+' · '+actualUnit+
  '</span><span>三角面 '+input.metrics.triangles.toLocaleString("zh-CN")+
  ' · SHA '+shortHash+'</span></footer>'+
  '<div class="warn">视图为正交投影；尺寸来自三角网格的轴向包围盒，仅供审阅，不作为机械制造、公差或测量报告。</div>'+
  '</main></body></html>';
}

export function openModelPrint(input:ModelPrintData,popup:Window):void{
 const html=modelPrintSheetHtml(input);
 popup.document.open();
 popup.document.write(html);
 popup.document.close();
 popup.document.getElementById("print-now")?.addEventListener("click",()=>popup.print());
 popup.focus();
}
