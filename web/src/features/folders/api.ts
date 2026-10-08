import{request}from "../../shared/http";
import type{Folder}from "../../entities/folder/model";
export const folderApi={tree:()=>request<Folder[]>("/folders/tree")};
