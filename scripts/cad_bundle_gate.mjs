#!/usr/bin/env node
// Run only on remote target after npm run build. Assert that the CAD route
// and three.js code are not statically bundled into the normal documents UI.
import {readdirSync,statSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";

const assets=resolve("web/dist/assets");
const names=readdirSync(assets).filter(name=>name.endsWith(".js"));
const main=names.find(name=>/^index-[\w-]+\.js$/.test(name));
const cad=names.find(name=>/^ModelViewer-[\w-]+\.js$/.test(name));
const three=names.find(name=>/^three\.module-[\w-]+\.js$/.test(name));
if(!main||!cad||!three)throw Error(
 `CAD_BUNDLE_FAIL expected independent main, ModelViewer and three.js chunks: ${names.join(",")}`);
const mainBytes=statSync(join(assets,main)).size;
const cadBytes=statSync(join(assets,cad)).size;
const threeBytes=statSync(join(assets,three)).size;
// The baseline before route splitting was ~569 KB. Keep at least 9 KB of
// headroom below it without tying CI to byte-level minifier variations.
if(mainBytes>560000||cadBytes<5000||threeBytes<200000){
 throw Error(`CAD_BUNDLE_FAIL main=${mainBytes} cad=${cadBytes} three=${threeBytes}`);
}
const source=readFileSync("web/src/app/App.tsx","utf8");
if(!source.includes('lazy(()=>import("../pages/ModelViewer")')){
 throw Error("CAD_BUNDLE_FAIL ModelViewer route is not lazy-loaded");
}
console.log(`CAD_BUNDLE_PASS main=${mainBytes}B cad_page=${cadBytes}B three=${threeBytes}B`);
