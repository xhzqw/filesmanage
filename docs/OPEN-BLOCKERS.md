# Open blockers

Status date: 2026-10-09 (BLK-12/13/14/15/16 closed; matrix now 121 PASS / 4 PARTIAL / 1 EXTERNAL). The only remaining PARTIAL id set is BLK-11 (STEP assembly tree / MC02+MOD02), plus S12/S20 folded into BLK-05/BLK-01.

| ID | Blocker | Impact | Needed from customer / next probe |
|---|---|---|---|
| BLK-01 | Official 中晟生物科技 Logo binary not yet supplied (covers S20 / VS01-VS18 brand acceptance: shell delivered, logo asset missing) | Brand page shows explicit "标志待入库" placeholder per DEC-14; must not fake an official logo | Customer delivers verified logo asset (vector/raster) for import |
| BLK-02 | ~~DOCX editor engine~~ RESOLVED | — | ONLYOFFICE 8.2.2 (AGPL) self-hosted in Docker on 18080 with JWT; DO01–DO14-style E2E verified in M5 |
| BLK-03 | DWG preview requires a commercial SDK/license (ODA Teigha or similar) | DWG support stays licence-blocked; DXF (native 2D) is delivered | Customer decision: license purchase or accept DWG = documented unsupported |
| BLK-04 | ~~STEP/IGES converter toolchain~~ RESOLVED | — | gmsh + OpenCASCADE 7.8 installed in the worker; real geometry verified (544 triangles) |
| BLK-05 | Production port 8091 / systemd cutover not authorized (covers S12: units written and syntax-verified but not installed; upgrade/rollback drill not executed) | Delivery stays on dev port 18091; production switch requires explicit approval + backup/rollback drill | Explicit go-live authorization after acceptance gates |
| BLK-06 | 2026-10-08 ~22:00: host unreachable on 192.168.1.22 (100% packet loss, no ARP entry) for ~40 min | Implementation paused; resumed over 10.144.144.1 with no data or service loss | Customer to confirm the network path; add a second management route if this recurs |
| BLK-07 | Shared-host capacity: PostgreSQL instance (max_connections=100) and CPU shared with unrelated services (load 6–7) | §24.3 budgets met at ≤10 users, 10/11 at 30 users; 100/200 users pool-bound | Dedicated reference environment per SPEC PERF-003, or an approved capacity ADR |
| ~~BLK-08~~ | `/search` page was missing from the React app | RESOLVED | SearchPanel shipped (commit `3dd8682`): filters, result table, safe `<mark>` snippets, "1000+" capped total; browser-verified |

| ~~BLK-09~~ | DO05 byte-level fidelity after commit | RESOLVED | `scripts/do05_header_footer_check.py` (15/15): header/footer/page-break all survive the real commit path |
| ~~BLK-10~~ | AG12 CAD-saturation isolation | RESOLVED | `scripts/pe12_cad_saturation.py` PASS 7/7 in the 2026-10-09 final re-run (x0.93–x1.14, all inside the SPEC 25% budget). The one earlier failing run (x1.64) was traced to the loopback perf instance co-running and contaminating the baseline; with the perf instance stopped the same script passes. Latency-measuring gates must run with the perf instance stopped. |

| BLK-11 | STEP 多组件装配树与零件显隐未实现（MC02, MOD02）：gmsh 转换输出单一合并网格，查看器无零件树/独立显隐/bbox | 机械装配类文件只能整体查看，不能按组件隐藏/高亮 | 转换器保留组件边界（按 gmsh physical group 输出多 mesh 或改用 OCCT XCAF 路径），查看器增加零件树 |
| ~~BLK-12~~ | 材质/纹理关联未实现（MC06 OBJ+MTL、MC07 glTF 外部 .bin/textures、MC09 3MF 多部件材质） | RESOLVED | `scripts/mc_multiasset_check.mjs` 15/15：siblingResolver（MTLLoader + LoadingManager URL modifier）把相对资源映射到同目录兄弟文件，三类多样资源样本全部按预期三角形数渲染，兄弟资源真实拉取，无外部请求 |
| ~~BLK-13~~ | 单位提示与量测标注未实现（MC05, MOD03, MOD04, MOD05） | RESOLVED | `scripts/mod03_meta_check.mjs` 30/30：元数据面板（格式/版本/源 SHA/尺寸/组件数/派生 SHA/警告，SHA 与版本逐字段对 API 断言）；STL 与 glTF 显示“未知单位（不按毫米计算）”，声明单位的 3MF 显示原值；尺寸一律带“近似（三角化网格）”标注 |
| ~~BLK-14~~ | 查看器控制面不完整（MOD01, MOD07） | RESOLVED | `scripts/mod01_controls_check.mjs` 10/10：控件全部实现并经 CDP 实测（切换改变画面且可逆、重置视角精确恢复初始取景）；WebGL 丢失与超大文件均有可操作错误 + 下载入口 |
| ~~BLK-15~~ | 回滚/并发/崩溃恢复边角断言缺失（RB-T06, RB-T07, RB-T08, RB-T10, RB-T11, AG09） | RESOLVED | rb_rollback_e2e.py 72/72（并发单胜、审批 pending/拒绝/重复、五类媒体字节 SHA、共享 blob 留存）+ scripts/ag09_recovery_drill.py 4/4（staging 安全序 + 启动清扫，并新增 Store.SweepStaging） |
| ~~BLK-16~~ | CAD 负向路径断言缺失（MC04, MC14, MC16, MC17, MOD10） | RESOLVED | mc_cad_e2e.py 78/78：畸形输入明确失败（worker 空网格守卫）、并发转换收敛单一 derivative、pending 期间派生保持旧版、外部纹理不抓取、恶意文件名被拒、损坏 zip 不解压 |

- ~~查看器控制面不完整~~ → BLK-14 closed: reset/fit framing (with damping-residue flush, a real bug found by the check), axes/grid toggles, perspective/orthographic swap, webglcontextlost handling and a 256 MB inline guard, all verified by `scripts/mod01_controls_check.mjs` (10/10).

- ~~CAD 负向路径无断言~~ → BLK-16 closed: mc_cad_e2e.py now asserts malformed-input rejection (which exposed a real gap: gmsh exits 0 on unreadable geometry and writes an empty STL, so the worker gained a geometry guard), concurrent-request dedupe, pending-approval derivative stability, no server-side texture fetch, hostile-filename rejection and no server-side archive extraction.

- ~~多样资源模型（OBJ+MTL、glTF+bin/贴图、3MF 多部件）不解析~~ → BLK-12 closed: siblingResolver maps relative references onto sibling files through the API (MTLLoader + LoadingManager URL modifier), verified by `scripts/mc_multiasset_check.mjs` (15/15).
- ~~文件列表 limit=200 文档最大值返回 400~~ → repository guard was off by one against the service's page+1 lookahead; fixed with a shared `ports.MaxFilePage` constant, a Go boundary test (`TestListFilesAcceptsMaxPageSize`) and HTTP-level checks in `s_matrix_e2e.py` (35/35). Found by the multi-resource work; the OpenAPI sort enums were also wrong and are now corrected.

- ~~无单位提示/元数据面板/近似量测标注~~ → BLK-13 closed: the viewer publishes a metadata panel (format, version, source SHA, dimensions, component count, derivative SHA, warnings), reports 未知单位 for every mesh format instead of assuming millimetres (only 3MF's declared unit is shown), and labels every dimension readout 近似（三角化网格）; verified field-by-field against the API by `scripts/mod03_meta_check.mjs` (30/30).

- ~~回滚/并发/崩溃恢复边角无断言~~ → BLK-15 closed: rb_rollback_e2e.py 72/72 (concurrent rollback single-winner with gap-free seq, approval-policy pending/reject/duplicate paths, byte-exact rollback across plain/BOM/CRLF/DOCX/STEP, shared-blob survival) and scripts/ag09_recovery_drill.py 4/4, which also added the missing startup sweep (`Store.SweepStaging`) so a crash before the database commit no longer leaves staging files behind forever.

Resolved this milestone:
- ~~Folder-filtered search/stats/export could bypass the visibility scope~~ → scope intersection + placeholder fix, 31/31 E2E.
- ~~Shares ignored include_descendants and were absent from direct permission checks~~ → unified share resolution.
- ~~CSV export clamped at 200 rows and fully buffered~~ → batched streaming export, 9/9 checks.
- ~~Search index never written; content search was a sequential ILIKE scan~~ → indexing pipeline + tsvector GIN search.
- ~~Concurrent lock acquisition 500'd~~ → file row lock serialisation.
- ~~Download ignored Range (no video seeking)~~ → http.ServeContent.
- ~~CAD worker failed on content-addressed blob conflicts~~ → adopt existing blob; stale tag check fixed.
- ~~M8 restore drill needed fresh evidence~~ → drill PASS (26 tables, 41 blobs) + 12/12 manifest unit tests.
