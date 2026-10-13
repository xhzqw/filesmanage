// Private, same-page drag format. Never interpret OS "Files" drags as labels.
export const LABEL_DRAG_MIME="application/x-filesmanage-label-resources";
export type LabelDragResources={fileIds:string[];folderIds:string[]};
export function readLabelDrag(transfer:DataTransfer):LabelDragResources|null{
 if(!Array.from(transfer.types).includes(LABEL_DRAG_MIME)||Array.from(transfer.types).includes("Files"))return null;
 try{
  const value:unknown=JSON.parse(transfer.getData(LABEL_DRAG_MIME));
  if(!value||typeof value!=="object")return null;
  const source=value as Partial<LabelDragResources>;
  if(!Array.isArray(source.fileIds)||!Array.isArray(source.folderIds))return null;
  const valid=(items:unknown[])=>items.every(id=>typeof id==="string"&&id.length>0&&id.length<=256)&&new Set(items).size===items.length;
  if(!valid(source.fileIds)||!valid(source.folderIds)||source.fileIds.length+source.folderIds.length===0||source.fileIds.length+source.folderIds.length>100)return null;
  return {fileIds:source.fileIds,folderIds:source.folderIds};
 }catch{return null;}
}
