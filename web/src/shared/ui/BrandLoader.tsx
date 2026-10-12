import "./brand-loader.css";
import {type ReactNode} from "react";

/** High-density alpha cutout of the verified company logo. No guessed
 *  low-resolution SVG contours, white matte, or external animation runtime.
 */
export type BrandLoaderSize="xs"|"sm"|"md"|"lg";
/** Inline wait text, without introducing a new block or disturbing table cells. */
export function BrandLoadingLabel({children,size="xs"}:{children:ReactNode;size?:BrandLoaderSize}){
 return <span className="brand-loading-content"><BrandLoader decorative size={size}/><span>{children}</span></span>;
}
export function BrandLoader({size="md",label="正在加载",decorative=false,className=""}:{
 size?:BrandLoaderSize;label?:string;decorative?:boolean;className?:string;
}){
 return <span
  className={"brand-loader"+(className?" "+className:"")}
  data-loader-size={size} data-loader-decoration={decorative||undefined}
  role={decorative?undefined:"status"} aria-label={decorative?undefined:label}
  aria-hidden={decorative?true:undefined}>
  <img className="brand-loader-ink" src="/assets/brand/logo-loader-256.png" alt="" draggable={false}/>
  <span className="brand-loader-mask" aria-hidden="true"><span className="brand-loader-glow"/></span>
 </span>;
}
