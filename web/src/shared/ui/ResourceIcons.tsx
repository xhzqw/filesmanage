// All app folders share the Rare UI folder component adaptation.
import "./resourceIcons.css";
import {RareFolderComponent} from "./rare/FolderComponent";
export function FolderResourceIcon({open=false,hovered=false,size=16,className=""}:{open?:boolean;hovered?:boolean;size?:number;className?:string}){
 return <RareFolderComponent open={open} hovered={hovered} size={size} className={className}/>;
}
export {FileTypeIcon as FileResourceIcon} from "./FileTypeIcon";
