# filesmanage v2.1 — Precision Workbench 设计合同包

版本：**v1.0.0-draft**  · 日期：2026-10-09  · 状态：**提案，未修改项目仓库，未运行/部署**

## 本包目的
把对正确的 v2.1 Go/React 工作副本所做的静态 UI/UX 审计，变成可由本地 Agent 分阶段实施、只在远端验证的工程合同。它**不是**当前系统已经通过新 UX 验收的证明。

## 文件
1. `docs/design/DESIGN-SYSTEM-v1.md` — 品牌 Token、组件外观与状态、Shell、布局/密度和视觉治理。
2. `docs/design/DESKTOP-INTERACTION-v1.md` — 单击选中/双击打开、焦点与选择锚点、右键、快捷键、目录树、拖放与异步状态。
3. `docs/design/COMPLEX-WORKFLOWS-v1.md` — Safe Text Editor、FolderPicker、文件/目录移动 API 草案、权限、上传、版本、恢复、共享等工作流。
4. `docs/design/UX-ACCEPTANCE-v1.md` — 静态审计问题台账、按 ID 的安全/桌面/工作流/视觉/性能验收用例、G0–G5 门禁。

## 合同优先级
1. 当前服务器真实运行代码与测试事实；无权修改的业务契约由服务端与主 SPEC 决定。
2. `docs/SPEC-v2.1.md`、`AGENTS.md`、已生效的正式 ADR。
3. 本包经评审批准的设计规则（在被整合入主 SPEC 前均为**草案**）。
4. UI 示意和候选尺寸/颜色；与主 SPEC 不同时必须出 ADR，不能静默漂移。

## 审计范围与事实边界
- 本地：`/Users/lai7177w/code/work/filesmanage`，已确认为 Go/Gin + React/TS 的新工作副本；Git 工作树在当时的只读查询中为空（不能等同远端 HEAD 同步证据）。
- 远端：`root@192.168.1.22`（22 端口；备用 `10.144.144.1`），真实运行仓库 `/root/repository77/filesmanage-v21`，Web 开发入口 `:18091`。
- 只读审计覆盖了 `web/src` 主要界面、`internal/httpx/router.go` 等 API 路由、部分业务代码、`docs/SPEC-v2.1.md`、部署与验收文档。当前未登录线上业务页面验证所有视觉/行为，也未在远端重新执行任何测试。
- 交付文档中的具体行为缺口以**审计时源码**为依据，其他 Agent 如果已修改需以新 commit 对照更新。不要把现有后端 123 PASS 自动当作这些新的 UX 用例通过。

## 实施入口（交给 Agent）
1. 同步/核对本地 `main` 与远端 `main` 精确 SHA，先阅读 `AGENTS.md`；不要操作旧 Node 工程。
2. 把本包 4 份文件加入仓库 `docs/design/`，审定候选 ADR（本次没有替你提交/推送）。
3. 先做 `G0`：**防截断文本覆盖、统一 ApiError**，在远端安全复现/回归；不要先铺 CSS。
4. `G1` 设计系统与 Shell；`G2` 桌面资源选择；`G3` 目录/文件移动与 FolderPicker；`G4` 其他业务闭环；`G5` 远端 UX + 既有门禁完整验收。
5. 新 Go API 先补主 SPEC、OpenAPI、ACL/事务/幂等/审计测试。禁止 UI-only 的假移动/假复制按钮。
6. 始终遵守远端测试/部署与 dev `18091`、生产 `8091` 不触碰、密钥不复制到本地的规定。

## 尚需决策（有默认建议，但**未获产品签收**）
- `ADR-UX-01` 跨页全选语义：首期当前加载页。
- `ADR-UX-02` 批量移动：all-or-nothing，冲突时无任何写入。
- `ADR-UX-03` 文件移动 endpoint 和预检、幂等键持久化。
- `ADR-UX-04` 权限有效来源与解释接口。
- `ADR-UX-05` 上传队列并发与取消语义。
- `ADR-UX-06` App Canvas 候选 `#F6F8FB` 与主 SPEC `#F4F9FE`，审定后统一。
- `ADR-UX-07` 大树分批加载与现有 `/folders/tree` 兼容演进。

## 禁止误报
- 本包是设计文档，不含真实实施代码或新 API，也没有执行新 UX 测试；默认验收全是 NOT_RUN。
- 不称主系统“未完成”或“不安全”；已发现的前端风险需要远端可复现与差异修复。
- 对于正式 Logo、DWG 商业许可、8091 上线授权、专用压测环境，延续已登记的外部阻断，不自行绕过。
