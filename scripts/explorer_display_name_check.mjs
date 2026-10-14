#!/usr/bin/env node
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";

// Run the real production TS function through the installed TS transpiler;
// do not reimplement name shortening in the test.
const require=createRequire(import.meta.url);
const ts=require("../web/node_modules/typescript");
const source=readFileSync("web/src/features/documents/explorerDisplayName.ts","utf8");
const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const module={exports:{}};
runInNewContext(output,{module,exports:module.exports});
const compact=module.exports.compactExplorerName;
for(const [input,check] of [
 ["旅程目录-1791769428124",name=>name==="旅程目录…8124"],
 ["普门-糖化血红蛋白校准品-9SX1230070(1)_副本.pdf",name=>name.startsWith("普门-糖化血红蛋白")&&name.endsWith("…(1)_副本.pdf")],
 ["RFID-RC522 .step",name=>name==="RFID-RC522.step"],
 ["RFID-RC522.step",name=>name==="RFID-RC522.step"],
 ["设备图纸中文说明.docx",name=>name==="设备图纸中文说明.docx"],
 ["ZL-03-JLB04医用监测设备多批次复核表格.xls",name=>name.includes("…")&&name.endsWith(".xls")],
 ["pe11-verify-1791469382.step",name=>name.includes("…")&&name.endsWith(".step")],
 ["custom-20261014131324123.mp4",name=>name.includes("…")&&name.endsWith(".mp4")]
]){
 const display=compact(input);
 assert(check(display),JSON.stringify({input,display}));
}
console.log("EXPLORER_DISPLAY_NAME_PASS");
