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
 const safeRatio=Number.isFinite(pageRatio)&&pageRatio>0?pageRatio:1.414;
 const extents=rotatedStampExtents(p,angle,safeRatio);
 // Clamp the rotated artwork, not only its unrotated edit box. Very large
 // stamps should shrink to fit instead of extending beyond the scanned page.
 const factor=Math.min(1,extents.halfX>0?.98/(extents.halfX*2):1,extents.halfY>0?.98/(extents.halfY*2):1);
 const scaled={...p,width:p.width*factor,height:p.height*factor};
 const {halfX,halfY}=rotatedStampExtents(scaled,angle,safeRatio);
 const centerX=Math.max(halfX,Math.min(1-halfX,p.x+p.width/2));
 const centerY=Math.max(halfY,Math.min(1-halfY,p.y+p.height/2));
 return {...scaled,x:centerX-scaled.width/2,y:centerY-scaled.height/2};
}
