import type {PreviewData} from "../../entities/file/model";

/** The API renderer is signature-backed; file names are only hints for links.
 * No extension ever authorizes unsafe inline HTML/SVG execution. */
export type PreviewAdapter="image"|"video"|"audio"|"pdf"|"text"|"archive"|"spreadsheet"|"presentation"|"document"|"cad"|"unsupported";

const CAD_EXT=new Set(["stl","obj","glb","gltf","step","stp","iges","igs","dxf","dwg","3mf","ply","msh"]);
export function resolvePreviewAdapter(preview:PreviewData):PreviewAdapter {
 const supported:PreviewAdapter[]=["image","video","audio","pdf","text","archive","spreadsheet","presentation","document"];
 if(preview.renderer && supported.some(type=>type===preview.renderer)) return preview.renderer as PreviewAdapter;
 const ext=preview.name.split(".").at(-1)?.toLowerCase()??"";
 return CAD_EXT.has(ext)?"cad":"unsupported";
}
export const ADAPTER_TITLES:Record<PreviewAdapter,string>={
 image:"图片",video:"视频",audio:"音频",pdf:"PDF 文档",text:"文本 / 代码",
 archive:"压缩包目录",spreadsheet:"电子表格",presentation:"演示文稿",document:"文字文档",
 cad:"CAD 图纸 / 模型",unsupported:"文件",
};
