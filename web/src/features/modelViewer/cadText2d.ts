/** Convert DXF TEXT/MTEXT into readable glyphs, not visible control codes.
 * SHX shaping and rich MTEXT layout still require a full CAD font engine. */
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
  .replace(/\\[PX]/g,"\n")
  .replace(/\\S([^;]{1,60});/g,(_,fraction:string)=>fraction.replace(/[#^]/g,"/"))
  // Alignment, height, width, tracking, font and color are markup, not text.
  .replace(/\\[AaCcFfHhQqTtWw][^;\\\r\n]{0,160};/g,"")
  .replace(/\\p[^;\\\r\n]{0,160};/g,"")
  .replace(/\\~/g," ")
  .replace(/\\[LlOoKk]/g,"")
  .replace(/\\([{}\\])/g,"$1")
  .replace(/[{}]/g,"")
  .slice(0,400);
}

export type CadTextStyle={fontFile:string;widthFactor:number;fixedHeight:number};
export type CadFont={family:string;approximate:boolean;requested:string};
/** Allowlisted font aliases, not arbitrary font paths or injected CSS names.
 * The browser chooses the first locally installed member of each chain.
 * No proprietary DXF TTF/SHX file is fetched or redistributed. */
export function cadFontFamily(style:CadTextStyle|undefined,styleName="STANDARD"):CadFont{
 const raw=(style?.fontFile??"").split(/[\\/]/).pop()?.trim()??"";
 const filename=raw.toLowerCase().replace(/\.(ttf|otf|ttc|shx|shp)$/,"");
 const cadShapeFont=/\.(shx|shp)$/i.test(raw);
 const name=styleName.trim().toLowerCase();
 const key=(filename+" "+name).replace(/[_-]/g," ");
 const requested=raw||styleName;
 const result=(family:string,approximate=false):CadFont=>({family,approximate,requested});
 const cjkSans='Arial, "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Liberation Sans", sans-serif';
 if(/simsun|simhei|simshei|fangsong|kaiti|hztxt|hztext|gbcbig|chinese|宋体|黑体/.test(key))
  return result(cjkSans,true);
 // Comic Sans' proprietary fonts are absent on many Linux installations.
 // Use a deliberately distinct script fallback rather than Arial pretending
 // to be a handwritten font. Z003 is installed on many Linux CAD workstations.
 if(/\bcomic\b|comicsans|comic sans|comicsansms/.test(key))
  return result('"Comic Sans MS", "Comic Neue", "Segoe Print", "Z003", "URW Chancery L", cursive',true);
 if(/arialn|arial narrow/.test(key))
  return result('"Arial Narrow", "Liberation Sans Narrow", "Roboto Condensed", sans-serif',true);
 if(/ariblk|arial black/.test(key))
  return result('"Arial Black", "DejaVu Sans", sans-serif',true);
 if(/\barial\b|^arial(?:bd|bi|i|b)?\b/.test(key))
  return result(cjkSans);
 if(/times|romant|romans|georgia/.test(key))
  return result('"Times New Roman", "Liberation Serif", Georgia, serif',cadShapeFont);
 if(/sourcecodepro|source code pro|consolas|mono|courier/.test(key))
  return result('"Source Code Pro", Consolas, "Liberation Mono", monospace',cadShapeFont);
 if(/calibri|aptos/.test(key))
  return result('Calibri, Aptos, Carlito, sans-serif',true);
 if(/simplex|iso(cp|ct|eur)|gothic|txt|\.shx$/.test(key)||/\.(shx|shp)$/i.test(raw))
  return result(cjkSans,true);
 // Unknown CAD font is visibly approximate, not falsely called Arial.
 return result(cjkSans,Boolean(raw)||name!=="standard");
}
