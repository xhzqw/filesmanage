export type StampRect={x:number;y:number;width:number;height:number};

// Source PDF coordinates are normalized to its top-left corner.
// A positive angle rotates clockwise in the browser.
export function rotatedStampExtents(p:StampRect,angleDegrees:number,pageRatio:number){
 const theta=angleDegrees*Math.PI/180;
 const c=Math.abs(Math.cos(theta)),s=Math.abs(Math.sin(theta));
 return {halfX:(p.width*c+p.height*pageRatio*s)/2,
         halfY:(p.height*c+p.width/pageRatio*s)/2};
}
export function stampFitsPage(p:StampRect,angle:number,pageRatio:number){
 if(!Number.isFinite(pageRatio)||pageRatio<=0||!Number.isFinite(angle)||Math.abs(angle)>180)return false;
 const {halfX,halfY}=rotatedStampExtents(p,angle,pageRatio);
 const cx=p.x+p.width/2,cy=p.y+p.height/2;
 const e=1e-8;
 return halfX<=.5+e&&halfY<=.5+e&&cx>=halfX-e&&cx<=1-halfX+e&&cy>=halfY-e&&cy<=1-halfY+e;
}
export function fitStampToPage(p:StampRect,angle:number,pageRatio:number):StampRect{
 const {halfX,halfY}=rotatedStampExtents(p,angle,pageRatio);
 if(halfX>.5||halfY>.5)return p;
 const centerX=Math.max(halfX,Math.min(1-halfX,p.x+p.width/2));
 const centerY=Math.max(halfY,Math.min(1-halfY,p.y+p.height/2));
 return {...p,x:centerX-p.width/2,y:centerY-p.height/2};
}
