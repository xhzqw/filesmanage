export type TrashEntry={
 id:string;
 oldName:string;
 fileId?:string;
 folderId?:string;
 oldParentId?:string;
 oldParentTrail?:{id:string;name:string}[];
 oldParentPath?:string;
 deletedBy:string;
 deletedByName:string;
 deletedAt:string;
 subtreeCount?:number;
};
