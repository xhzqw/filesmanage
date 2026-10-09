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
 renderer?:"text"|"image"|"video"|"audio"|"unsupported";
 mediaType?:string;
 truncated:boolean;
 content:string;
 // Exact preview-prefix bytes (BOM included), base64. Only present for
 // textual files; the Safe Text Editor round-trips through these bytes so
 // nothing is re-encoded or newline-normalised (COMPLEX-WORKFLOWS-v1 §1).
 rawBase64?:string;
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
