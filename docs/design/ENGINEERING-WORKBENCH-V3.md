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

## Delivered in V3.2 drawing-fidelity increment

- DXF rational B-spline/NURBS evaluation: degree, knot multiplicities and
  positive rational weights; sampling is a **rendering approximation** while
  the source controls stay double precision. Fit-point-only and malformed
  splines are reported, not guessed from unvalidated control geometry.
- DIMENSION display through the DXF-provided anonymous dimension
  representation BLOCK, including nested entities. Missing graphical blocks
  are reported rather than generating an invented dimension.
- Line colours: per-entity ACI, group 420 TrueColor, BYLAYER/BYBLOCK and
  insertion-layer inheritance. Geometry batches by layer and effective colour.
- Legacy POLYLINE/VERTEX/SEQEND is assembled independently for each BLOCK and
  model-space list, avoiding cross-INSERT vertex contamination.
- Malicious or corrupt DXF protection: finite-angle normalization without
  potentially unbounded loops; bounded line and expanded-entity budgets.
- Regression fixtures cover rational quarter circles, dimension graphical
  coordinates, nested blocks, entity colours and hostile angle values.

## Delivered in V3.3 drawing and sheet increment

- HATCH closed-polyline solid fills with nested hole/island rings are
  triangulated as real geometry; rendering opacity is a preview convention,
  not a claim of faithful CAD printing. Bulge boundaries are sampled.
- Invalid/open boundary paths, gradient/pattern fills and unsupported edge
  paths are reported without pretending that an entire region is solid.
- Entity group 410 named Layout and group 67 paper-space fallback isolate
  drawing entities. Layout tabs live in the compact CAD title bar and switch
  to a freshly fitted, resource-disposed viewport.
- Parsing budgets bound per-file tessellated hatch vertices and total
  scene triangles. Synthetic geometry regression verifies true cut-out area.
- Chrome WebGL regression renders a real HATCH mesh with DXF labels/curves
  and verifies that paper-only entities do not leak into Model Space.

## Delivered in V3.4 engineering drawing increment

- HATCH pattern-family lines are evaluated from DXF angle (53), family base
  (43/44), offset vector (45/46), dash counts (79) and lengths (49). Generated
  strokes are clipped against the actual even-odd polyline boundary including
  holes. Unsupported gradients, complex edge contours and excessive line
  density are explicitly reported. This is a geometry-preview subset, not
  plot-perfect reproduction of every Autodesk hatch style.
- STYLE table (text font file, width factor, fixed height) and TEXT entity
  style, scale, rotation and common engineering glyph codes are interpreted.
  No arbitrary external font paths are fetched; SHX uses a marked browser-font
  approximation rather than claiming faithful glyph metrics.
- Paper VIEWPORT entities with rectangular geometry display their frame.
  Model-space projection, nonrectangular clipping and frozen layer overrides
  remain unsupported and are reported, not silently invented.
- Each selected Model/Paper layout can be exported as a PNG of the visible
  preview at browser resolution. This is **not** CAD scale-controlled plotting
  or a replacement for the original source drawing.
- DXF and Chromium regression covers hatch line/negative-offset/dash
  clipping, common text symbols, STYLE fallback, viewport framing, view
  selection and PNG capture. Geometry/resource safety limits remain active.

## Delivered in V3.5 bounded paper-space projection increment

- VIEWPORT fields 40/41 are parsed as **paper width/height**, not height and
  aspect ratio. Group 45 remains model-space view height. View twist (51)
  is interpreted in **radians**. The WCS target (17/27) and DCS view center
  (12/22) are combined with the twist to locate the model view correctly.
- Normal XY-oriented, orthographic, rectangular paper viewports now render
  the existing model linework into the paper rectangle at the corresponding
  scale, clipped with Liang-Barsky and preserving source layer/color.
- The drawing inspector reports projected versus total VIEWPORT count.
  Complex boundary / per-viewport frozen layers, off/perspective viewports,
  tilted view direction and invalid geometry are not silently projected.
- The projected model subset is limited to line segments, including linework
  sampled from supported DXF analytic curves and block geometry. TEXT sprites,
  HATCH meshes and unsupported 3D or complex entities are **not** transplanted
  into the viewport; a compatibility notice is shown when incomplete.
- Parsing the model geometry for paper projection is cached per layout parse;
  input size and projected-segment budgets cap memory and render work.
- Geometry regression tests check paper width/height interpretation, 2D
  scale, clipping, 90-degree twist, nonzero WCS target, source ACI colors and
  rejection of tilted/perspective views. Remote headless Chrome exercises a
  rendered projected paper layout across desktop/narrow viewport sizes.

## Delivered in V3.6 engineering sheet composition increment

- Rectangular XY orthographic VIEWPORTs can now project model-space HATCH
  triangles and rasterized TEXT/MTEXT glyphs in addition to linework.
  Filled geometry is intersected with the paper viewport rectangle before
  rasterization, and text quads interpolate UVs across clipped edges.
  This is an approximation for CAD text, especially SHX glyph metrics.
- Group 331 frozen-layer references are resolved through the DXF LAYER table
  handle (group 5), including tables that put the handle before the name.
  Filtering is applied per VIEWPORT. An unknown handle yields a compatibility
  notice instead of silently painting potentially hidden content.
- A3/A4 landscape **fit-to-page raster print preview** is available for
  selected paper layouts. It uses the current WebGL drawing snapshot and
  physically sized browser print media; it is not a CAD plotter, does not
  guarantee 1:1 or 1:N source units on paper, and is not a vector PDF.
- Projection memory is bounded for source line segments, HATCH vertices,
  annotation textures and clipped triangles. Original source GPU resources
  are disposed after collecting non-destructive drawing data.
- Geometry regressions verify clipping area, glyph UV extents, frozen-layer
  handle resolution and missing-handle warnings. Headless Chrome verifies
  fill/glyph composition, frozen layer isolation and print page template.

## Deliberately unsupported or approximate

| Capability | Current truth | Next gate |
| --- | --- | --- |
| DWG | Licensed SDK required; not asserted as compatible | Legal/converter review |
| STEP/IGES | Converted MSH triangles | Original B-Rep topology and exact kernel queries |
| True assembly hierarchy | Imported hierarchy where provided; MSH mesh groups otherwise | Stable instance IDs and assembly tree |
| 3D measurement | Mesh-coordinate approximate straight distance | Exact B-Rep edge/face measurements |
| DXF SPLINE/NURBS | Knots/degree/weights supported; fit-point-only interpolation not supported | Fit-point solver, discontinuous curve fidelity |
| DXF DIMENSION | Anonymous representation BLOCK when present | Full DIMSTYLE overrides and absent-block fallback |
| DXF HATCH | Solid fills and bounded pattern-family strokes clipped against closed polyline contours, with holes | Edge-boundary paths, gradients, advanced hatch styles and exact plot fidelity |
| DXF paper space, XREF | Layout isolation and bounded 2D XY orthographic VIEWPORT lines, raster glyphs and solid HATCH composition, frozen layers by handle; PNG/A3/A4 fit-to-page output | Full 3D perspective/tilted view, complex clipping, CAD print scale, XREF |
| DXF arc/ellipse | Tessellated preview | Analytic segment and center/angle snap records |
| DXF text | STYLE lookup, width/rotation, Unicode symbols; Canvas font fallback | True SHX metrics, advanced MTEXT formatting, annotation scales |
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
