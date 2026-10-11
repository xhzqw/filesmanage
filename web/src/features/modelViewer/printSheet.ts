export type SheetSize="A3"|"A4";

/** Browser print preview for the CURRENT rendered paper layout.
 * Deliberately fit-to-paper: not a CAD plot scale or vector export. */
export function printableSheetHtml(png:string,size:SheetSize,layout:string):string{
 if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png))
  throw new Error("无效的图纸快照");
 const paper=size==="A3"?{width:420,height:297}:{width:297,height:210};
 const title=layout.slice(0,100).replace(/[&<>"']/g,char=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
 }[char]??char));
 const width=paper.width-20,height=paper.height-20;
 return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
  '<title>工程图 - '+title+'</title>'+
  '<style>@page{size:'+size+' landscape;margin:0}'+
  'html,body{margin:0;background:#fff;color:#253b53;font-family:Arial,sans-serif}'+
  '.sheet{box-sizing:border-box;width:'+paper.width+'mm;height:'+paper.height+
  'mm;padding:10mm;display:flex;flex-direction:column;align-items:center;justify-content:center}'+
  '.sheet img{display:block;max-width:'+width+'mm;max-height:'+height+
  'mm;width:100%;height:100%;object-fit:contain}'+
  '@media screen{body{background:#f0f4f8}.sheet{margin:16px auto;box-shadow:0 4px 25px #0002}}'+
  '</style></head><body><main class="sheet"><img alt="'+title+
  '" src="'+png+'"></main></body></html>';
}

export function printCurrentSheet(png:string,size:SheetSize,layout:string):boolean{
 const html=printableSheetHtml(png,size,layout);
 const popup=window.open("","_blank");
 if(!popup)return false;
 popup.document.open();
 popup.document.write(html);
 popup.document.close();
 const screenshot=popup.document.querySelector("img");
 const print=()=>{popup.focus();popup.print();};
 if(screenshot?.complete)print();
 else screenshot?.addEventListener("load",print,{once:true});
 return true;
}
