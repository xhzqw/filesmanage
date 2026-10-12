export type FileMetadata={fileId:string;category:string;description:string;tags:string[];updatedBy:string;updatedAt:string};

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
 renderer?:"text"|"image"|"video"|"audio"|"pdf"|"archive"|"spreadsheet"|"presentation"|"document"|"unsupported";
 structured?:StructuredPreview;
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

export type StructuredPreview={
 kind:"archive"|"spreadsheet"|"presentation"|"document";
 entries:{name:string;size:number;directory:boolean}[];
 sections:{title:string;lines:string[]}[];
 truncated:boolean;
 note:string;
};
// Version comparison is shared by the document viewer and approval review.
export type CompareDiffLine={kind:"equal"|"added"|"removed";left?:number;right?:number;text:string};
export type OfficeSemanticChange={kind:"added"|"removed"|"changed";section:string;key:string;before:string;after:string};
export type VersionComparison={left:{seq:number;sha256:string;sizeBytes:number};right:{seq:number;sha256:string;sizeBytes:number};mode:"identical"|"metadata"|"large"|"text";detail?:"office_parts"|"office_semantic";semanticChanges?:OfficeSemanticChange[];lines:CompareDiffLine[];added:number;removed:number};
