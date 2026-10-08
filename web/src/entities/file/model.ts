export type FileItem={
 id:string;
 folderId:string;
 name:string;
 uploadedBy:string;
 contentType:string;
 sizeBytes:number;
 sha256:string;
 currentVersionSeq:number;
 updatedAt:string;
 // Search projection only: a bounded plain-text window around the match
 // (SPEC §10.3); rendered as escaped text nodes plus <mark>.
 snippet?:string;
};

export type FileVersion={
 versionSeq:number;
 sha256:string;
 sizeBytes:number;
 action:"upload"|"edit"|"rollback"|"restore";
 baseSeq?:number;
 rollbackTargetSeq?:number;
 rollbackFromSeq?:number;
 reason?:string;
 createdBy:string;
 createdAt:string;
};

export type PreviewData={
 fileId:string;
 name:string;
 contentType:string;
 size:number;
 sha256:string;
 textual:boolean;
 truncated:boolean;
 content:string;
 byteMeta:{
  size:number;
  sha256:string;
  encoding:string;
  hasBom:boolean;
  eol:string;
  endsWithNewline:boolean;
  printable:boolean;
 };
};
