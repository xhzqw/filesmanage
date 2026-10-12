/** A derivative request is valid only for formats supported by this server.
 * The status API already reports the capability class, so never send a POST
 * for licensed/unverified/unknown formats just to discover a predictable 400.
 */
export type DerivativeDisposition="request"|"existing"|"unsupported";
export function cadDerivativeDisposition(info:{found:boolean;class:string}):DerivativeDisposition{
 if(info.class!=="native"&&info.class!=="converted")return "unsupported";
 return info.found?"existing":"request";
}
