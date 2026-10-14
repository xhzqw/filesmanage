// Visual middle truncation for Finder's narrow icon and column views.
// Only the displayed copy changes: title and API identifiers stay intact.
const wideCharacter=/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u;
const graphemes=new Intl.Segmenter("zh-CN",{granularity:"grapheme"});
const clusters=(text:string)=>Array.from(graphemes.segment(text),part=>part.segment);
const clusterWidth=(cluster:string)=>[...cluster].some(character=>wideCharacter.test(character))?2:1;
function visualWidth(text:string):number{
 return clusters(text).reduce((total,cluster)=>total+clusterWidth(cluster),0);
}
function visualSlice(text:string,maxWidth:number):string{
 let result="",used=0;
 for(const character of clusters(text)){
  const width=clusterWidth(character);
  if(used+width>maxWidth)break;
  result+=character;used+=width;
 }
 return result;
}
function visualTail(text:string,maxWidth:number):string{
 let result="",used=0;
 for(const cluster of clusters(text).reverse()){
  const width=clusterWidth(cluster);
  if(used+width>maxWidth)break;
  result=cluster+result;used+=width;
 }
 return result;
}
export function compactExplorerName(name:string):string{
 // Remove display-only whitespace before a file extension; never rename it.
 const normalized=name.trim().replace(/\s+(?=\.[a-zA-Z0-9]{1,8}$)/u,"");
 const extensionMatch=normalized.match(/^(.*)\.([a-zA-Z0-9]{1,8})$/u);
 const extension=extensionMatch?.[2]??"";
 const extWithDot=extension?"."+extension:"";
 const stem=(extensionMatch?.[1]??normalized).trim();
 if(visualWidth(stem)<=22)return stem+extWithDot;
 const timestamp=stem.match(/^(.*?)[-_.]?(\d{10,})$/u);
 if(timestamp){
  const head=visualSlice((timestamp[1]??"").replace(/[-_.\s]+$/u,""),13);
  if(visualWidth(head)>=3)return head+"…"+(timestamp[2]??"").slice(-4)+extWithDot;
 }
 const duplicate=stem.match(/(\(\d+\)[-_]?副本(?:\d+)?)$/u);
 const suffix=duplicate?visualTail(duplicate[1],16):visualTail(stem,10);
 const prefix=visualSlice(stem.slice(0,stem.length-suffix.length).replace(/[-_.\s]+$/u,""),duplicate?18:14);
 return (prefix||visualSlice(stem,14))+"…"+suffix+extWithDot;
}
