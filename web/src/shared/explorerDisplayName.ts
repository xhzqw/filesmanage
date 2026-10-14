/** Visual-only resource titles: full names remain in API fields and tooltips. */
export type ExplorerNameContext="grid"|"column"|"list"|"sidebar";
const wideCharacter=/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u;
const segmenter=new Intl.Segmenter("zh-CN",{granularity:"grapheme"});
const graphemes=(text:string)=>Array.from(segmenter.segment(text),part=>part.segment);
const glyphWidth=(part:string)=>[...part].some(c=>wideCharacter.test(c))?2:1;
export const explorerVisualWidth=(value:string)=>graphemes(value).reduce((sum,part)=>sum+glyphWidth(part),0);
function takeVisual(value:string,limit:number,fromEnd=false):string{
 const parts=graphemes(value);
 if(fromEnd)parts.reverse();
 let width=0;
 const kept:string[]=[];
 for(const part of parts){
  const step=glyphWidth(part);
  if(width+step>limit)break;
  kept.push(part);width+=step;
 }
 return (fromEnd?kept.reverse():kept).join("");
}
function stripTrailing(value:string){return value.replace(/[-_.\s…]+$/u,"");}
export function compactExplorerName(name:string,context:ExplorerNameContext="grid"):string{
 const normalized=name.trim().replace(/\s+(?=\.[a-zA-Z0-9]{1,8}$)/u,"");
 if(context==="list")return normalized;
 const parts=normalized.match(/^(.*)\.([a-zA-Z0-9]{1,8})$/u);
 const extension=parts?.[2]?"."+parts[2]:"";
 const stem=(parts?.[1]??normalized).trim();
 // Column/sidebar budgets include the extension. Grid titles have two lines.
 const budget=context==="grid"?32:18;
 const timestamp=stem.match(/^(.*?)[-_.]?(\d{8,})$/u);
 if(timestamp&&explorerVisualWidth(stem)>16){
  const end=(timestamp[2]??"").slice(-4);
  const room=Math.max(1,budget-explorerVisualWidth(extension)-explorerVisualWidth(end)-1);
  const head=takeVisual(stripTrailing(timestamp[1]??""),room);
  if(explorerVisualWidth(head)>=3)return head+"…"+end+extension;
 }
 if(explorerVisualWidth(stem+extension)<=budget)return stem+extension;
 const copy=stem.match(/(\(\d+\)[-_]?副本(?:\d+)?)$/u);
 const suffix=copy?.[1]??takeVisual(stem,context==="grid"?10:5,true);
 const suffixBudget=Math.min(explorerVisualWidth(suffix),Math.max(3,budget-explorerVisualWidth(extension)-4));
 const tail=takeVisual(suffix,suffixBudget,true);
 const headRoom=Math.max(1,budget-explorerVisualWidth(extension)-explorerVisualWidth(tail)-1);
 const head=stripTrailing(takeVisual(stem.slice(0,stem.length-tail.length),headRoom));
 return (head||takeVisual(stem,headRoom))+"…"+tail+extension;
}
