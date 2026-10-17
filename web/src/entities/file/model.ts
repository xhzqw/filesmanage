export type FileMetadata={fileId:string;category:string;description:string;tags:string[];updatedBy:string;updatedAt:string};

export type FileLineage={
 id:string;name:string;ext:string;versionSeq:number;createdAt:string;
 sourceFileId:string;sourceFileName:string;sourceVersionSeq:number;
 relationType:"docx_to_pdf"|"pdf_to_docx"|"seal_copy";
};
export type LineageData={lineageParent:FileLineage|null;lineageChildren:FileLineage[]};

export type FileItem={
 id:string;
 folderId:string;
 name:string;
 uploadedBy:string;
 contentType:string;
 sizeBytes:number;
 sha256:string;
 currentVersionSeq:number;
 sourceFileId?:string;
 sourceFileName?:string;
 sourceVersionSeq?:number;
 relationType?:FileLineage["relationType"];
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
 lineageParent?:FileLineage|null;
 lineageChildren?:FileLineage[];
 sourceFileId?:string;
 sourceFileName?:string;
 sourceVersionSeq?:number;
 relationType?:FileLineage["relationType"];
 name:string;
 contentType:string;
 size:number;
 sha256:string;
 textual:boolean;
 renderer?:"text"|"image"|"video"|"audio"|"pdf"|"archive"|"spreadsheet"|"presentation"|"document"|"mindmap"|"unsupported";
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

export type XMindAnnotation={title?:string;range?:string};
export type XMindRelationship={fromId:string;toId:string;title?:string};
export type XMindTopic={
 id?:string;title:string;kind?:string;structure?:string;collapsed?:boolean;
 link?:string;image?:string;color?:{fill?:string;text?:string};
 notes?:string;labels?:string[];markers?:string[];
 boundaries?:XMindAnnotation[];summaries?:XMindAnnotation[];
 children?:XMindTopic[];
};
export type XMindSheet={title:string;structure?:string;root:XMindTopic;relationships?:XMindRelationship[]};
export type XMindPreview={
 sheets:XMindSheet[];topicCount:number;truncated:boolean;images?:Record<string,string>;
};
export type StructuredPreview={
 kind:"archive"|"spreadsheet"|"presentation"|"document"|"mindmap";
 mindMap?:XMindPreview;
 entries:{name:string;size:number;directory:boolean}[];
 sections:{title:string;lines:string[]}[];
 truncated:boolean;
 note:string;
};
// Version comparison is shared by the document viewer and approval review.
export type CompareDiffLine={kind:"equal"|"added"|"removed";left?:number;right?:number;text:string};
export type OfficeSemanticChange={kind:"added"|"removed"|"changed";section:string;key:string;before:string;after:string};
export type VersionComparison={left:{seq:number;sha256:string;sizeBytes:number};right:{seq:number;sha256:string;sizeBytes:number};mode:"identical"|"metadata"|"large"|"text";detail?:"office_parts"|"office_semantic";semanticChanges?:OfficeSemanticChange[];lines:CompareDiffLine[];added:number;removed:number};
