import {MshLimitError,parseMshAssembly} from "./mshParser";

self.onmessage=(event:MessageEvent<{buffer:ArrayBuffer}>)=>{
 try{
  const result=parseMshAssembly(event.data.buffer);
  const transfer:Transferable[]=[];
  for(const part of result.parts)transfer.push(part.positions.buffer,part.normals.buffer);
  self.postMessage({ok:true,data:result},transfer);
 }catch(error){
  self.postMessage({
   ok:false,tooLarge:error instanceof MshLimitError,
   error:error instanceof Error?error.message:"网格解析失败",
  });
 }
};
