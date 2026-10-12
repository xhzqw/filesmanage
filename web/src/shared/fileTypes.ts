// Single source of truth for file identity, search filters and UI artwork.
export type FileCategory = "all" | "cad" | "doc" | "image" | "media" | "archive" | "code" | "other";
export type FileKind = "cad" | "word" | "sheet" | "slide" | "pdf" | "image" | "media" | "archive" | "code" | "text" | "file";
export type FileVisual = "word" | "sheet" | "slide" | "pdf" | "image" | "video" | "audio" | "archive" | "code" | "text" | "drawing" | "solid" | "mesh" | "toolpath" | "font" | "file";
type Identity = Readonly<{kind:FileKind;category:FileCategory;visual:FileVisual}>;
const info=(kind:FileKind,category:FileCategory,visual:FileVisual):Identity=>({kind,category,visual});
const unknown=info("file","other","file");
const extensions=new Map<string,Identity>();
function register(exts:string,kind:FileKind,category:FileCategory,visual:FileVisual){
 const value=info(kind,category,visual);
 for(const ext of exts.split(" "))extensions.set(ext,value);
}
register("doc docx docm dot dotx dotm wps wpt odt ott rtf pages","word","doc","word");
register("xls xlsx xlsm xlsb xlt xltx xltm csv tsv ods ots et numbers","sheet","doc","sheet");
register("ppt pptx pptm pps ppsx pot potx potm odp dps key","slide","doc","slide");
register("pdf","pdf","doc","pdf");
register("png jpg jpeg jfif gif webp bmp svg svgz tif tiff heic heif avif ico icns apng psd ai eps raw cr2 nef arw dng","image","image","image");
register("mp4 m4v mov mkv avi webm wmv flv mpg mpeg 3gp mts m2ts vob ogv","media","media","video");
register("mp3 wav flac aac m4a ogg oga opus wma aiff aif mid midi ape","media","media","audio");
register("zip rar 7z tar gz tgz bz2 tbz2 xz txz zst tzst cab iso dmg jar war apk deb rpm","archive","archive","archive");
register("dwg dxf dwt dws dgn dgnlib idw ipn slddrw drw sch pcb kicad_pcb kicad_sch","cad","cad","drawing");
register("step stp stpz iges igs x_t x_b sat sab sldprt sldasm prt asm ipt iam f3d f3z 3dxml catpart catproduct jt par psm ifc ifczip rvt rfa skp 3dm","cad","cad","solid");
register("stl obj 3mf ply fbx glb gltf 3ds blend dae usd usdz usda usdc amf off wrl vrml abc","cad","cad","mesh");
register("gcode gco nc tap cnc ngc cls apt","cad","cad","toolpath");
register("json jsonc jsonl ndjson xml yaml yml toml ini conf config js cjs mjs ts mts cts jsx tsx html htm css scss sass less vue svelte py go sh bash zsh fish sql c cc cpp cxx h hpp hxx java kt kts rs rb php swift cs fs fsx dart lua pl pm r ipynb gradle","code","code","code");
register("txt md markdown mdx rst log nfo tex bib srt vtt ass sub eml msg epub mobi azw azw3","text","doc","text");
register("ttf otf woff woff2 eot","file","other","font");
const specialCodeNames=new Set([".env",".gitignore",".gitattributes",".editorconfig",".dockerignore","dockerfile","makefile","justfile","jenkinsfile","cmakelists.txt"]);
export function getFileTypeInfo(name:string):Identity{
 const base=name.trim().replace(/\\/g,"/").split("/").pop()?.toLowerCase()??"";
 if(specialCodeNames.has(base)||base.startsWith(".env."))return info("code","code","code");
 const dot=base.lastIndexOf(".");
 const ext=dot>0&&dot<base.length-1?base.slice(dot+1):"";
 return extensions.get(ext)??unknown;
}
export function classifyFile(name:string):{kind:FileKind;category:FileCategory}{
 const {kind,category}=getFileTypeInfo(name);
 return {kind,category};
}
