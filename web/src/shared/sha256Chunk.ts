// SHA-256 for per-chunk integrity. WebCrypto digest is unavailable over
// non-secure LAN HTTP; the bounded pure-JS fallback avoids disabling checks.
const K=new Uint32Array([
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
 0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
 0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
 0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
 0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
 0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
function rotate(x:number,n:number){return(x>>>n)|(x<<(32-n));}
function word(data:Uint32Array,index:number):number{return data[index]??0;}
export function sha256Fallback(data:Uint8Array):string{
 const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
 const paddedLength=Math.ceil((data.length+9)/64)*64;
 const padded=new Uint8Array(paddedLength);padded.set(data);padded[data.length]=0x80;
 const view=new DataView(padded.buffer);
 const bits=data.length*8;
 view.setUint32(paddedLength-8,Math.floor(bits/0x100000000),false);
 view.setUint32(paddedLength-4,bits>>>0,false);
 const w=new Uint32Array(64);
 for(let offset=0;offset<paddedLength;offset+=64){
  for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4,false);
  for(let i=16;i<64;i++){
   const a=word(w,i-15),b=word(w,i-2);
   const s0=rotate(a,7)^rotate(a,18)^(a>>>3);
   const s1=rotate(b,17)^rotate(b,19)^(b>>>10);
   w[i]=(word(w,i-16)+s0+word(w,i-7)+s1)>>>0;
  }
  let a=word(H,0),b=word(H,1),c=word(H,2),d=word(H,3),e=word(H,4),f=word(H,5),g=word(H,6),h=word(H,7);
  for(let i=0;i<64;i++){
   const s1=rotate(e,6)^rotate(e,11)^rotate(e,25);
   const ch=(e&f)^(~e&g);
   const t1=(h+s1+ch+word(K,i)+word(w,i))>>>0;
   const s0=rotate(a,2)^rotate(a,13)^rotate(a,22);
   const maj=(a&b)^(a&c)^(b&c);
   const t2=(s0+maj)>>>0;
   h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
  }
  H[0]=(word(H,0)+a)>>>0;H[1]=(word(H,1)+b)>>>0;H[2]=(word(H,2)+c)>>>0;H[3]=(word(H,3)+d)>>>0;
  H[4]=(word(H,4)+e)>>>0;H[5]=(word(H,5)+f)>>>0;H[6]=(word(H,6)+g)>>>0;H[7]=(word(H,7)+h)>>>0;
 }
 return [...H].map(x=>x.toString(16).padStart(8,"0")).join("");
}
export async function sha256Chunk(buffer:ArrayBuffer):Promise<string>{
 if(globalThis.crypto?.subtle){
  try{return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",buffer))]
   .map(x=>x.toString(16).padStart(2,"0")).join("");}catch{}
 }
 return sha256Fallback(new Uint8Array(buffer));
}
