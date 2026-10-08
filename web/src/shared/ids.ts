// crypto.randomUUID exists only in secure contexts (https or localhost); LAN
// http access must still produce unique idempotency keys.
export function newIdempotencyKey():string{
 if(typeof crypto!=="undefined"&&typeof crypto.randomUUID==="function"){
  return crypto.randomUUID();
 }
 const bytes=new Uint8Array(16);
 if(typeof crypto!=="undefined"&&typeof crypto.getRandomValues==="function"){
  crypto.getRandomValues(bytes);
 }else{
  for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
 }
 return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
