import {request} from "../../shared/http";
import type {Folder} from "../../entities/folder/model";

export const folderApi={
 tree:()=>request<Folder[]>("/folders/tree"),
 create:(parentId:string,name:string)=>request<Folder>("/folders",{method:"POST",body:JSON.stringify({parentId,name})}),
 rename:(id:string,name:string)=>request<Folder>("/folders/"+id,{method:"PATCH",body:JSON.stringify({name})}),
 move:(id:string,targetParentId:string)=>request<Folder>("/folders/"+id+"/move",{method:"POST",body:JSON.stringify({targetParentId})}),
 remove:(id:string)=>request<{trashId:string;folders:number}>("/folders/"+id,{method:"DELETE"}),
};
