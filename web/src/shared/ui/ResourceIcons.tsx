// All app folders share the Rare UI folder component adaptation.
import "./resourceIcons.css";
import {RareFolderComponent} from "./rare/FolderComponent";
/** Finder rails and path breadcrumbs use monochrome symbols, never the
 * full-colour resource artwork reserved for the content canvas. */
export function FinderLineIcon({kind,size=16,className=""}:{kind:"folder"|"file";size?:number;className?:string}){
 return <svg className={"finder-line-icon"+(className?" "+className:"")} width={size} height={size}
  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
  {kind==="folder"?<><path d="M3 7.5a2 2 0 0 1 2-2h4.6l2.2 2.3H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/></>:<><path d="M6 2.8h8.2L19 7.6V20a1.8 1.8 0 0 1-1.8 1.8H6A1.8 1.8 0 0 1 4.2 20V4.6A1.8 1.8 0 0 1 6 2.8Z"/><path d="M14.2 2.8v5H19M8 12h7M8 15.5h7"/></>}
 </svg>;
}
export function FolderResourceIcon({open=false,hovered=false,size=16,className=""}:{open?:boolean;hovered?:boolean;size?:number;className?:string}){
 return <RareFolderComponent open={open} hovered={hovered} size={size} className={className}/>;
}
export {FileTypeIcon as FileResourceIcon} from "./FileTypeIcon";
