/** Decode ASCII DXF without replacing legacy Chinese codepage bytes. */
const CODEPAGES:Record<string,string>={
 ANSI_936:"gb18030",ANSI_950:"big5",ANSI_932:"shift_jis",
 ANSI_949:"euc-kr",ANSI_874:"windows-874",ANSI_1250:"windows-1250",
 ANSI_1251:"windows-1251",ANSI_1252:"windows-1252",
 ANSI_1253:"windows-1253",ANSI_1254:"windows-1254",
 ANSI_1255:"windows-1255",ANSI_1256:"windows-1256",
 ANSI_1257:"windows-1257",ANSI_1258:"windows-1258",
 DOS936:"gb18030",GBK:"gb18030",GB2312:"gb18030",
 BIG5:"big5",UTF8:"utf-8","UTF-8":"utf-8",
};
export function decodeDxfBytes(bytes:ArrayBuffer):string{
 const source=new Uint8Array(bytes);
 const signature="AutoCAD Binary DXF";
 if(source.length>=signature.length&&
  [...signature].every((char,index)=>source[index]===char.charCodeAt(0)))
  throw new Error("当前不支持二进制 DXF，请导出 ASCII DXF 后预览");
 // Modern DXF generators may retain an obsolete $DWGCODEPAGE header.
 // Always try lossless UTF-8 before interpreting the original raw bytes.
 try{return new TextDecoder("utf-8",{fatal:true}).decode(source);}
 catch{/* Legacy ANSI text: use original bytes, not a lossy decoded string. */}
 const header=new TextDecoder("windows-1252").decode(source.subarray(0,Math.min(source.length,262144)));
 const declared=/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]+)/i.exec(header)?.[1]?.trim().toUpperCase();
 const charset=declared?CODEPAGES[declared]??"windows-1252":"gb18030";
 try{return new TextDecoder(charset).decode(source);}
 catch{return new TextDecoder("windows-1252").decode(source);}
}
