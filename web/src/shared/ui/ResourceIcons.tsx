// Shared file-system glyphs across the application.
import "./resourceIcons.css";
export function FolderResourceIcon({open=false,size=16,className=""}:{open?:boolean;size?:number;className?:string}){
 return <svg className={"resource-folder-icon"+(className?" "+className:"")} data-folder-open={open} width={size} height={size} viewBox="0 0 24 24"
  fill="none" stroke="var(--folder-stroke,#C28B21)" strokeWidth="1.5"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
  <path fill="var(--folder-fill,#F5BF43)" d="M3 7V5a2 2 0 0 1 2-2h4l2.1 2.5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
  {open
   ?<path className="resource-folder-front" fill="var(--folder-open-fill,#F9D47C)" d="M4 20a2 2 0 0 1-1.9-2.6l1.5-5A2 2 0 0 1 5.5 11H21a1 1 0 0 1 1 1.3l-2 6.2a2 2 0 0 1-1.9 1.5Z"/>
   :<path d="M3 9h18"/>}
 </svg>;
}
// Backwards-compatible API: all resource callers use one colored file glyph.
export {FileTypeIcon as FileResourceIcon} from "./FileTypeIcon";
