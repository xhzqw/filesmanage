/** Shared 14px chevron for Office and PDF page controls. */
export function ReaderPageChevron({direction}:{direction:"previous"|"next"}){
 return <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d={direction==="previous"?"m10 3-5 5 5 5":"m6 3 5 5-5 5"}/>
 </svg>;
}
