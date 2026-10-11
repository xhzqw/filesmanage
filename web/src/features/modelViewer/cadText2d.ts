/** DXF TEXT/MTEXT plain-string glyph interpretation for a read-only preview.
 * The full SHX shaping/MTEXT formatting engine is deliberately out of scope. */
export function decodeCadText(source:string):string{
 return source
  .replace(/%%[dD]/g,"°")
  .replace(/%%[pP]/g,"±")
  .replace(/%%[cC]/g,"⌀")
  .replace(/\\U\+([0-9A-Fa-f]{4,6})/g,(_,hex:string)=>{
   const cp=Number.parseInt(hex,16);
   return cp>=0x20&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)
    ?String.fromCodePoint(cp):"�";
  })
  .replace(/\\P/g,"\n")
  .replace(/\\S([^;]{1,60});/g,(_,fraction:string)=>fraction.replace(/[#^]/g,"/"))
  .replace(/\\~/g," ")
  .replace(/\\[LlOoKk]/g,"")
  .replace(/\{\\[^;{}]*;/g,"")
  .replace(/[{}]/g,"")
  .slice(0,400);
}

export type CadTextStyle={fontFile:string;widthFactor:number;fixedHeight:number};
/** Local known-font fallbacks: never load arbitrary DXF paths or remote URLs. */
export function cadFontFamily(style:CadTextStyle|undefined):{family:string;approximate:boolean}{
 const filename=(style?.fontFile??"").split(/[\\/]/).pop()?.toLowerCase()??"";
 if(filename.includes("times")||filename.includes("romant"))
  return{family:"Georgia, serif",approximate:filename.endsWith(".shx")};
 if(filename.includes("mono")||filename.includes("courier"))
  return{family:"monospace",approximate:filename.endsWith(".shx")};
 return{family:"Arial, 'Microsoft YaHei', sans-serif",
  approximate:filename.endsWith(".shx")||filename.endsWith(".shp")};
}
