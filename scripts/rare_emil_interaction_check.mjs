#!/usr/bin/env node
// Read-only static anti-regression assertions for RareUI interaction contracts.
// Remote browser journeys remain the authority for actual geometry/behaviour.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const table=read("web/src/features/documents/FileTable.tsx");
const dragPreview=read("web/src/features/documents/dragPreview.ts");
const dragStyle=read("web/src/features/documents/dragMove.css");
const toast=read("web/src/shared/ui/ToastViewport.tsx");
const toastStyle=read("web/src/shared/ui/toast.css");
const theme=read("web/src/theme.css");
const preview=read("web/src/pages/Preview.tsx");
const previewStyles=read("web/src/pages/previewWorkbenchV2.css");
const workflow=read("scripts/ux_workflows_check.mjs");

assert.match(table,/setMoveDragImage\(dataTransfer,item\.name,ids\.length\)/,"drag should use shared filename preview");
assert.match(table,/setData\("text\/plain",ids\.length===1\?item\.name:/,"text fallback must be filename-first");
assert.doesNotMatch(table,/setData\("text\/plain",ids\.length===1\?item\.name:`移动 /,"avoid verbose drag text");
assert.match(dragPreview,/title\.textContent=name/,"drag label must be safe text");
assert.match(dragPreview,/transfer\.setDragImage\(preview,/,"do not snapshot full table row");
assert.match(dragStyle,/\.file-drag-ghost-name\{[^}]*text-overflow:ellipsis/,"long drag labels truncate");
assert.match(theme,/\.table tbody tr\.selected,\.table tbody tr\.selected:hover\{[^}]*box-shadow:none/,"one selected surface, no extra left rail");
assert.match(toast,/const paused=hovered\|\|focused\|\|hidden/,"toast must pause on interaction/hidden page");
assert.match(toast,/animationPlayState:paused\?"paused":"running"/,"visual lifetime matches timer pause");
assert.match(toast,/EXIT_MS\/1000/,"exit animation and TTL share the same exit budget");
assert.match(toastStyle,/@media\(prefers-reduced-motion:reduce\)/,"reduced motion is required");
assert.match(previewStyles,/\.file-workbench-side-actions \.file-workbench-actions\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,"preview primary actions use one balanced row");
assert.match(preview,/moreOpen&&<div className="file-action-expansion"/,"preview More expands directly inside the sidebar");
assert.match(previewStyles,/\.file-action-expansion\{[^}]*flex-direction:column/,"upward expansion is a compact vertical action group");
assert.match(workflow,/Input\.dispatchMouseEvent/,"native drag browser gate must exercise actual pointer input");
assert.match(workflow,/DI-17 native drag of selection opens two-file batch move/,"multi-file native drag scope must be checked");
assert.match(workflow,/DI-17 OS file drag cannot impersonate internal move/,"OS upload drag must stay distinct from internal move");
console.log("RARE_EMIL_INTERACTION_PASS: drag, selection, toast lifecycle, preview actions");
