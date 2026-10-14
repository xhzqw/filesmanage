// Filename-only native preview. The connected node is captured by Chromium,
// WebKit and Firefox; removing it synchronously makes some engines drag <tr>.
export function setMoveDragImage(transfer:DataTransfer,name:string,count:number):void{
 const preview=document.createElement("div");
 preview.className="file-drag-ghost";
 preview.setAttribute("aria-label",count>1?`${name}，共 ${count} 个文件`:name);
 const title=document.createElement("span");
 title.className="file-drag-ghost-name";
 title.textContent=name;
 preview.append(title);
 if(count>1){
  const badge=document.createElement("span");
  badge.className="file-drag-ghost-count";
  badge.textContent=`+${count-1}`;
  preview.append(badge);
 }
 document.body.append(preview);
 try{
  transfer.setDragImage(preview,18,19);
 }finally{
  window.setTimeout(()=>preview.remove(),0);
 }
}
