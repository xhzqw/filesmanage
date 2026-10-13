import "./brand-loader.css";
import {type CSSProperties,type ReactNode} from "react";

/** High-density alpha cutout of the verified company logo. No guessed
 *  low-resolution SVG contours, white matte, or external animation runtime.
 */
export type BrandLoaderSize="xs"|"sm"|"md"|"lg";
/** Inline wait text, without introducing a new block or disturbing table cells. */
export function BrandLoadingLabel({children,size="xs"}:{children:ReactNode;size?:BrandLoaderSize}){
 return <span className="brand-loading-content" role="status" aria-label={typeof children==="string"?children:"加载中"}>
  <BrandLoader decorative size={size}/>
 </span>;
}
export function BrandLoader({size="md",label="加载中",decorative=false,className=""}:{
 size?:BrandLoaderSize;label?:string;decorative?:boolean;className?:string;
}){
 return <span
  className={"brand-loader"+(className?" "+className:"")}
  data-loader-size={size} data-loader-decoration={decorative||undefined}
  role={decorative?undefined:"status"} aria-label={decorative?undefined:label}
  aria-hidden={decorative?true:undefined}>
  <span className="brand-loader-mark" aria-hidden="true">
   <img className="brand-loader-ink" src="/assets/brand/logo-loader-256.png" alt="" draggable={false}/>
   <span className="brand-loader-mask"><span className="brand-loader-glow"/></span>
  </span>
  <span className="brand-loader-caption" aria-hidden="true">
   <span className="brand-loader-glyph" style={{"--glyph-order":0} as CSSProperties}>加</span>
   <span className="brand-loader-glyph" style={{"--glyph-order":1} as CSSProperties}>载</span>
   <span className="brand-loader-glyph" style={{"--glyph-order":2} as CSSProperties}>中</span>
   <span className="brand-loader-dots">...</span>
  </span>
 </span>;
}
