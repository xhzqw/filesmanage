export type TrashEntry={
 id:string;
 oldName:string;
 fileId?:string;
 folderId?:string;
 oldParentId?:string;
 deletedBy:string;
 deletedByName:string;
 deletedAt:string;
 subtreeCount?:number;
};
