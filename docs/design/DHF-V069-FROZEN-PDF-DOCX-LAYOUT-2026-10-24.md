# DHF V0.6.9 — 固定版本 PDF/DOCX 页面审阅与 G5 真实联动验收

> Document ID: DHF-ENG-FROZEN-LAYOUT-20261024-01  
> Version: V0.6.9 Development Draft · 2026-10-24  
> Status: **隔离开发试点验证；正式 Stage Gate、电子签名和受控发行禁止启用**  
> Branch: `feat/dhf-v06-gate-pilot` · PR #1  
> 基线：`docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`、`docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`、九阶段原始 XMind 来源。

## 1. 需求、边界与复用原则

V0.6.8 已可读取审核时绑定的精确 file_id、version_seq、Blob、SHA-256，但 PDF/DOCX 没有可查看的完整页面布局。V0.6.9 **复用原系统服务端 PDF 页图渲染（pdftoppm）和独立 Office 文档沙箱（bwrap＋soffice）**，让 G5 专业审核人查看对应受控版本的实际排版页，而不是在工作台另做一套自定义渲染，且绝不使用 Finder 当前版本接口。

此阶段为只读工程试点。展示“固定页图已校验”不等于已对原件正式签署，也不自动认可签章叠加修订或阶段批准。原始 PDF 的冻结字节由受控 `file_versions` 决定；本版不使用可变的“当前签章版本”替换证据。

## 2. 实际实现

| 范围 | 受控行为 |
|---|---|
| `internal/application/dhf_pilot_frozen_pages.go` | 重复校验审核人任务、项目/模板、原文件 Preview ACL、固定版本与 Blob 身份；只读取指定冻结 Blob，再对**同一份实际用于渲染的字节**重新计算 SHA-256/长度 |
| PDF | 使用原有 `rsc.io/pdf` 校验 PDF 结构与页数、`renderPDFPagePNG` 生成 PNG；限 20 MiB 源、最多 1,000 页 |
| DOCX | 使用原有 ZIP/OOXML 内容限额、`renderOfficePDFSource` 独立沙箱转 PDF，再用同一个 PNG 页渲染；限 12 MiB 源、32 MiB 衍生 PDF |
| `GET /api/workbench/dhf/tasks/{id}/evidence/{rid}/pages` | 仅授权审核人的固定 PDF/DOCX 页数，无签发或签章权限 |
| `GET /api/workbench/dhf/tasks/{id}/evidence/{rid}/page?page=N` | 返回私有 `image/png`（不缓存）；每个请求重验用户、文件 ACL、来源版本和真实磁盘字节 |
| `DHFFrozenPagePreview.tsx` | 嵌入现有 `/approvals` 工作台，上一页/下一页、加载和错误重试；不通过 iframe 打开浏览器 PDF 插件，不触发文件下载 |
| `scripts/gen_openapi.py` | 新接口定义，与源文件 `docs/openapi-implemented.yaml` 对齐 |

安全约束：任务分配并不是预览授权，必须满足文件本身的 Preview ACL；缓存为经过 SHA-256 分离的 DOCX 排版衍生物，**缓存命中仍不跳过当前访问授权和文件字节校验**；页图请求不会读取“最新版本”或授予访问原始 DOCX/PDF 下载权限。

## 3. 实际验证

在 `10.144.144.1` 的独立 Git 检出、临时 BlobStore 和 PostgreSQL 17 临时数据库中执行：

| 验证项 | 已执行结果 |
|---|---|
| DOCX → Office 沙箱 → PDF → PNG 真实转换 | **PASS**：`TestDHFExactPinnedDOCXAndPDFPageRenderer` |
| 原生 PDF 页面解析和栅格化 | **PASS**：相同测试验证原始 PDF 字节与页数 |
| 无效 PDF / 不支持格式拒绝 | **PASS** |
| G5 同批次 PDF 与 DOCX 证据、两个不同专业审核人 | **PASS**：`TestDHFPilotFrozenPDFDOCXRealPostgres` |
| Finder 当前版本由 v1 前进至 v2，审核仍来自固定 v1 | **PASS** |
| 未被指派的提交人不能借任务读取页图 | **PASS** |
| 审核人原文件预览 ACL 撤销后页图拒绝 | **PASS** |
| 原始 51 迁移在测试数据库加载 | **PASS**，无新增正式数据结构迁移 |
| Go 全包、go vet、Server/Worker/Migrate 构建 | **PASS**；远端提交 `5873291`，退出码 0 |
| Vite TypeScript 生产构建、OpenAPI/验收矩阵 `--check` | **PASS**：131 条 OpenAPI 路径，126 条验收矩阵，退出码 0 |

最终又从全新数据库执行了**联合集成回归**：`TestDHFPilotFrozenPDFDOCXRealPostgres` 和 `TestDHFPilotRealPostgresSubmission` 同时 PASS，原有证据固定、ACL、幂等、G5/G6 任务与复核审计并未被页图功能破坏。上述数据测试程序验证了真实数据库、真实底层 Blob 字节以及实际外部渲染程序的联动；它不等同于已在生产业务系统的浏览器上人工验收。既有 CDW 文件审批数据和运行系统不得被误删。

## 4. 必须继续执行的签审与整改门禁

1. **正式逐级签审**：审批模板默认逐级回签；允许受权越级介入，但中间责任保留为独立未豁免状态。签署时固定项目、stage/attempt/submission ID、policy/manifest SHA、签署角色、身份校验与时间戳。
2. **有据可追溯的退回与整改**：退回不能直接覆盖同一提交。必须有独立不变更的退回事件、整改任务、原始缺陷→整改证据→复验→新 Attempt 映射。
3. **总 Gate 与文件受控发行分离**：全部适用专业达到规定决议且整改关闭后才能生成阶段批准；文件发布和部门签收仍须 CDW 自身审批流程。
4. **签章修订与原文件身份**：具体受控发行所需的签章记录/签名身份/原始文件血缘应分别追溯，不能以当前签章叠加覆盖历史冻结 v1。
5. **安全与恢复**：物理 Blob 保留、备份恢复、网络隔离、授权撤销、LAN 并发压测及浏览器多尺寸实测。

**NO-GO：**此版本只交付固定版式的受权阅读与审核建议。**未部署正式签审流程，未执行真实项目最终阶段批准。**
