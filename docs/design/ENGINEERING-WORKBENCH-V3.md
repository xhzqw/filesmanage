# Engineering Workbench V3 — architecture and delivery ledger

Status: staged implementation, **not** a finished CAD authoring application.
Scope: non-destructive engineering file **viewing, inspection, measurement and review**.
This document records validated capability instead of marking unimplemented work complete.

## Boundary

1. The React route `ModelViewer` owns derivative loading, permissions-facing status
   and Rare UI controls. It must not implement geometric algorithms.
2. `viewerScene.ts` owns Three.js camera, rendering, picking, resource lifetime and
   the imperative viewport contract. 3D is Y-up; DXF drawing is XY on an
   orthographic camera. These must not silently mix coordinate conventions.
3. `dxf.ts` owns DXF record parsing and 2D entity-to-geometry conversion.
   It returns layers, unknown-unit status and explicit unsupported entity types.
4. `snap2d.ts` owns a viewport-independent segment index used for approximate
   line/endpoint/midpoint geometry snapping. The snap tolerance is converted
   from screen pixels to document units at the viewport boundary.
5. The CAD worker remains the only converter for STEP/IGES to triangle meshes.
   Converted mesh connectivity is **not** an authoritative STEP assembly tree.

## Delivered and tested in the current V3.1 slice

- Camera: six orthogonal views plus ISO; orthographic/perspective switching
  preserves field of view as closely as each projection permits; focus component.
- Scene: readable grid below opaque model, edges, display toggles and
  interactive direction cube. Geometry and GPU resources are released on dispose.
- Measurement: 3D triangle mesh is an **approximation**. During measurement,
  right-drag rotates in 3D, left-drag pans and wheel zoom remains available.
- DXF: LINE/CIRCLE/ARC/LWPOLYLINE, common POLYLINE, TEXT/MTEXT raster-glyph
  previews, POINT, ELLIPSE, and nested BLOCK/INSERT with translation, scale,
  rotation, insertion base and layer-0 inheritance. Cyclic blocks are rejected.
- 2D precision: document-space endpoints, midpoints and nearest-line snapping;
  inspect view discloses curve tessellation and unit uncertainty.
- Test gates: `web/scripts/cad-viewer-smoke.mjs` (geometry/regressions) and
  `web/scripts/cad-browser-smoke.mjs` (real software-WebGL Chromium scene,
  camera, resize and disposal) are included in remote `build.sh --with-tests`.

## Deliberately unsupported or approximate

| Capability | Current truth | Next gate |
| --- | --- | --- |
| DWG | Licensed SDK required; not asserted as compatible | Legal/converter review |
| STEP/IGES | Converted MSH triangles | Original B-Rep topology and exact kernel queries |
| True assembly hierarchy | Imported hierarchy where provided; MSH mesh groups otherwise | Stable instance IDs and assembly tree |
| 3D measurement | Mesh-coordinate approximate straight distance | Exact B-Rep edge/face measurements |
| DXF SPLINE/NURBS | Reported unsupported | Knot/weight/degree-correct evaluator |
| DXF HATCH/DIMENSION | Reported unsupported, no invented graphical fidelity | Boundary renderer / authentic DIMENSION blocks |
| DXF paper space, XREF | Not fully supported | Layout parser and secured resource resolution |
| DXF arc/ellipse | Tessellated preview | Analytic segment and center/angle snap records |
| DXF text | Canvas glyph approximation, not CAD SHX exact rendering | Font and text-style resolver |
| 2D/3D annotations and version diff | Not yet implemented | Version-bound review domain and permissions |

## Release constraints

- Build and test only on authorized remote target as required by AGENTS.md.
- No local app start, no unauthorized production port and no source file mutation
  from measurement or preview tools.
- Full TypeScript, UI governance, CAD synthetic regression, Chromium WebGL,
  Go tests and schema drift gates must pass before main integration.
- Visual correctness of complex customer drawings requires a **real reference
  file comparison** beyond synthetic fixtures; synthetic browser tests alone
  are not a universal fidelity certificate.
