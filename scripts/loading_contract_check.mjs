#!/usr/bin/env node
// Small source guard: loading motion belongs to one shared React component.
// Native select <option> placeholders and measured progress bars are exempt.
import {readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const read=path=>readFileSync(join(root,path),"utf8");
function requireContract(ok,message){
 if(!ok)throw new Error("Loading contract: "+message);
}

const loader=read("web/src/shared/ui/BrandLoader.tsx");
const css=read("web/src/shared/ui/brand-loader.css");
const buttons=read("web/src/shared/ui/rare/RareControls.tsx");
const toast=read("web/src/shared/ui/ToastViewport.tsx");
const toastCss=read("web/src/shared/ui/toast.css");
const app=read("web/src/app/App.tsx");
const png=readFileSync(join(root,"web/public/assets/brand/logo-loader-256.png"));

requireContract(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),"missing PNG brand mark");
requireContract(png[25]===6,"loading logo must have an RGBA alpha channel");
requireContract((loader.match(/className="brand-loader-glyph"/g)||[]).length===3,"three independent Chinese glyph nodes required");
requireContract(loader.includes(">加</span>")&&loader.includes(">载</span>")&&loader.includes(">中</span>"),"the loading caption must read 加载中");
requireContract(loader.includes("logo-loader-256.png")&&loader.includes("brand-loader-dots"),"loading mark and ellipsis required");
for(const fragment of ["animation-delay","opacity:","brand-loader-rhythm","prefers-reduced-motion"]){
 requireContract(css.includes(fragment),"motion or accessibility setting missing: "+fragment);
}
const glyphRule=css.match(/\.brand-loader-glyph\s*\{([^}]*)\}/)?.[1]??"";
const rhythmRule=css.match(/@keyframes\s+brand-loader-rhythm\s*\{([\s\S]*?)\n\}/)?.[1]??"";
requireContract(glyphRule.length>0&&rhythmRule.length>0,"glyph rhythm stylesheet missing");
for(const rule of [glyphRule,rhythmRule]){
 requireContract(!/(?:transform|translate|scale|rotate|filter|blur|drop-shadow|margin|padding)\s*:/i.test(rule),
  "loading text must remain physically stationary; only opacity may animate");
}
requireContract(buttons.includes('className="rare-button-pending"')&&buttons.includes('className="rare-button-content"'),
 "loading buttons must preserve original content geometry");
const buttonCss=read("web/src/shared/ui/rare/controls.css");
requireContract(buttonCss.includes(".rare-button-pending")&&buttonCss.includes("position:absolute"),
 "button loader must be overlaid, not replace layout content");
requireContract(buttonCss.includes('color:var(--text-inverse)')&&buttonCss.includes("filter:brightness(0) invert(1)"),
 "solid primary loading state must use high-contrast foreground and mark");
requireContract(toast.includes('item.tone==="loading"?<BrandLoader'),"toast must delegate to the shared component");
requireContract(toast.includes("loadingContext(item.text)"),"loading toast must not repeat loading copy");
requireContract(!toastCss.includes("rare-toast-spinner")&&!toastCss.includes("rare-toast-spin"),"legacy toast spinner still exists");
requireContract(app.includes('className="brand-loading-screen"')&&app.includes("<BrandLoader"),"route-level loader missing");
console.log("Loading contract OK: transparent logo, glyph rhythm, reduced motion, buttons, toast and route fallback");
