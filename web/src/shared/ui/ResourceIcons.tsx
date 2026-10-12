// All app folders share the Rare UI folder component adaptation.
import "./resourceIcons.css";
import {RareFolderComponent} from "./rare/FolderComponent";
export function FolderResourceIcon({open=false,size=16,className=""}:{open?:boolean;size?:number;className?:string}){
 return <RareFolderComponent open={open} size={size} className={className}/>;
}
export {FileTypeIcon as FileResourceIcon} from "./FileTypeIcon";
