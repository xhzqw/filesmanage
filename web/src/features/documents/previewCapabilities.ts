import type {FileItem,PreviewData} from "../../entities/file/model";
import {browserPrintKind} from "./browserPrint";
import {resolvePreviewAdapter} from "./previewAdapters";

/** Capability gates follow the trusted renderer, not the file suffix. */
export function previewCapabilities(preview:PreviewData,versionCount:number){
 const kind=resolvePreviewAdapter(preview);
 const office=["document","spreadsheet","presentation"].includes(kind);
 return {
  canPrint:browserPrintKind(preview)!==null,
  canCompare:versionCount>=2&&(office||(kind==="text"&&preview.textual&&!preview.truncated)),
  canReview:office||kind==="pdf"||(kind==="text"&&preview.textual),
  canSign:kind==="pdf"||(kind==="document"&&preview.name.toLowerCase().endsWith(".docx")),
  canEditText:kind==="text"&&preview.textual&&!preview.truncated,
 };
}

/** List metadata is only a hint; opening print still verifies the server preview.
 * Conservative whitelist avoids offering 'Print' for known media/CAD/archives. */
export function canOfferPrintFromListing(file:FileItem){
 if(/^(video|audio)\//i.test(file.contentType))return false;
 return /\.(?:pdf|docx|txt|png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name);
}
