// Icon tiles have a fixed, narrow Finder footprint. Keep the meaningful head
// and suffix of long ASCII IDs while leaving CJK titles and ordinary names
// untouched. The original name is retained as the title/accessible label.
export function compactExplorerName(name:string):string{
 const extensionMatch=name.match(/^(.*)(\.[a-zA-Z0-9]{1,8})$/);
 const extension=extensionMatch?.[2]??"";
 const stem=extensionMatch?.[1]??name;
 if(stem.length<20||!/^[\x21-\x7E]+$/.test(stem))return name;
 const timestamp=stem.match(/^(.*?)[-_]?(\d{10,})$/);
 if(timestamp){
  const head=(timestamp[1]??"").replace(/[-_.]+$/,"").slice(0,12);
  if(head.length>=3)return head+"…"+(timestamp[2]??"").slice(-4)+extension;
 }
 if(stem.length<=23)return name;
 return stem.slice(0,12).replace(/[-_.]+$/,"")+"…"+stem.slice(-5)+extension;
}
