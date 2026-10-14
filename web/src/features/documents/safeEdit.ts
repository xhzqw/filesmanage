import type {PreviewData} from "../../entities/file/model";

// Safe Text Editor gate (UX contracts COMPLEX-WORKFLOWS-v1 §1). The preview
// endpoint is a bounded, potentially lossy copy, so editing is only allowed
// when the exact bytes are available (rawBase64) and round-trip without any
// encoding or newline normalisation. Everything else is blocked with an
// actionable reason instead of silently writing a truncated or re-encoded
// file as a new version.

export type EditableText={
 text:string;
 eol:string;
 hasBom:boolean;
};

export type EditAssessment=
 |{editable:true;value:EditableText}
 |{editable:false;reason:string};

const BLOCKED_HINT="请下载文件后使用其他编辑器修改。";

function base64ToBytes(raw:string):Uint8Array{
 const binary=atob(raw);
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}

function utf8ToBase64(text:string):string{
 const bytes=new TextEncoder().encode(text);
 let binary="";
 for(const byte of bytes)binary+=String.fromCharCode(byte);
 return btoa(binary);
}

export function assessEditable(preview:PreviewData):EditAssessment{
 if(!preview.textual)return{editable:false,reason:"该文件不是可识别的纯文本格式，无法在网页编辑器中安全保存。"+BLOCKED_HINT};
 if(preview.truncated)return{editable:false,reason:"文件大小超过预览上限，当前没有完整字节读取路径；编辑并保存会写入不完整内容，已禁止。"+BLOCKED_HINT};
 if(!preview.byteMeta.printable)return{editable:false,reason:"文件包含二进制内容，无法按文本安全编辑。"+BLOCKED_HINT};
 // An empty file legitimately carries an empty rawBase64, so presence is a
 // type check, not a truthiness check.
 if(typeof preview.rawBase64!=="string")return{editable:false,reason:"无法获取文件的精确字节，暂时不能编辑。"+BLOCKED_HINT};
 // Mixed EOL cannot be reconstructed line-by-line after a user edit, so the
 // byte-fidelity strategy would be violated; editing stays disabled.
 if(preview.byteMeta.eol==="mixed")return{editable:false,reason:"文件混合使用 CRLF 与 LF 换行，编辑器无法逐行保留原始换行符。"+BLOCKED_HINT};
 let bytes:Uint8Array;
 try{bytes=base64ToBytes(preview.rawBase64);}catch{return{editable:false,reason:"文件字节无法解码，暂时不能编辑。"+BLOCKED_HINT};}
 let text:string;
 try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return{editable:false,reason:"文件不是有效的 UTF-8 文本，编辑器无法无损保存。"+BLOCKED_HINT};}
 // Round-trip proof: re-encoding the decoded text must reproduce the exact
 // original bytes minus the BOM the decoder strips for display.
 const body=preview.byteMeta.hasBom?bytes.subarray(3):bytes;
 const reencoded=new TextEncoder().encode(text);
 if(reencoded.length!==body.length||!reencoded.every((byte,index)=>byte===body[index])){
  return{editable:false,reason:"文件内容无法无损往返编码，暂时不能编辑。"+BLOCKED_HINT};
 }
 return{editable:true,value:{text,eol:preview.byteMeta.eol,hasBom:preview.byteMeta.hasBom}};
}

// Re-encodes edited text back to the file's original byte conventions: the
// edited content is normalised to LF first (the textarea may deliver either),
// then the original line-ending style and BOM are re-applied so untouched
// bytes keep their exact form.
export function encodeEditedText(text:string,eol:string,hasBom:boolean):string{
 let normalized=text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
 if(eol==="crlf")normalized=normalized.replace(/\n/g,"\r\n");
 if(hasBom)normalized="\uFEFF"+normalized;
 return utf8ToBase64(normalized);
}
