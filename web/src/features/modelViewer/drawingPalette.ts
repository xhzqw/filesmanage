/** Display contrast policy for a white DXF drawing sheet.
 *
 * CAD TrueColor can contain white/cyan/yellow values intended for a dark
 * editor model space. Preserve distinguishable hues, but darken low-contrast
 * strokes for readability. This does NOT mutate the source DXF file.
 */
export const DRAWING_PAPER=0xffffff;
export const DRAWING_INK=0x172a3b;
const linear=(channel:number)=>{
 const s=channel/255;
 return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;
};
export function paperContrast(color:number):number{
 const r=(color>>16)&255,g=(color>>8)&255,b=color&255;
 return 1.05/(.2126*linear(r)+.7152*linear(g)+.0722*linear(b)+.05);
}
export function readablePaperColor(source:number):number{
 if(!Number.isFinite(source))return DRAWING_INK;
 const value=Math.trunc(source)&0xffffff;
 if(paperContrast(value)>=4.5)return value;
 const r=(value>>16)&255,g=(value>>8)&255,b=value&255;
 // White and near-gray CAD pen 7 behave like black ink on white paper.
 if(Math.max(r,g,b)-Math.min(r,g,b)<20)return DRAWING_INK;
 // Preserve source hue as far as possible by darkening every channel together.
 let factor=.88;
 for(let i=0;i<24;i++,factor*=.88){
  const result=(Math.round(r*factor)<<16)|(Math.round(g*factor)<<8)|Math.round(b*factor);
  if(paperContrast(result)>=4.5)return result;
 }
 return DRAWING_INK;
}
