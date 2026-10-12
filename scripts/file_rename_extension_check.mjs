#!/usr/bin/env node
// Regression for the shared rename suffix guard (also used by upload retry).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "../web/node_modules/typescript/lib/typescript.js";

const source=readFileSync(new URL("../web/src/features/documents/fileExtensionChange.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {extensionChange,fileExtension}=await import("data:text/javascript;base64,"+Buffer.from(compiled.outputText).toString("base64"));

const cases=[
 ["drawing.dwg","drawing-final.dwg",null],
 ["drawing.DWG","drawing.dwg",null],
 ["drawing.dwg","drawing.dxf",{from:".dwg",to:".dxf"}],
 ["drawing.pdf","drawing",{from:".pdf",to:""}],
 ["drawing","drawing.pdf",{from:"",to:".pdf"}],
 ["report.tar.gz","report.tar.zip",{from:".gz",to:".zip"}],
 [".env",".env.backup",{from:"",to:".backup"}],
 ["report","report",null],
 ["file.","file.txt",{from:"",to:".txt"}],
 ["draft.PDF","draft.pdf  ",null],
];
for(const [before,after,expected] of cases){
 assert.deepEqual(extensionChange(before,after),expected,before+" → "+after);
}
assert.equal(fileExtension(".gitignore"),"");
assert.equal(fileExtension("a.b"),".b");
console.log("FILE_RENAME_EXTENSION_PASS: unchanged, case-only, changed, removed, added, dotfiles and compound suffixes");
