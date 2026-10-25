# DHF V0.7.1 — 逐级责任链、提前介入与中间责任保留

> Document ID: DHF-ENG-DUTY-CHAIN-20261024-01  
> Version: V0.7.1 · 2026-10-24 · Status: **development pilot / NOT authorized corporate electronic signing**  
> Branch: `feat/dhf-v06-gate-pilot` · PR #1  
> Engineering baseline: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`; `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`.

## 1. 需求依据、已确认决议和边界

系统采用原始 XMind DHF 九阶段结构，**G5“设计开发输出”**和 **G6“第一次设计开发转移”**拥有各自独立的审核身份；G8 不是 G6 的替身。源文本节点是设计来源/候选，不因标题同名变成受控必交文件。V0.6.7–V0.7.0 已实现冻结提交、文件 ACL、固定 PDF/DOCX 预览、专业试点复核和退回整改的不可变事务。用户已拍板：**默认逐级回签，允许经授权越级介入，但不会自动免除中间责任**。

V0.7.1 仅实现该已确认责任链的**审计可追踪试点层**，而非企业有效电子签署。没有经过独立身份再认证、正式签名凭证和已发布企业 SOP 审定前，`recommend_pass` 仍是试点意见，`early_intervention` 是登记的试点授权行为，均**不得**推导为签署完成、Gate accepted、CDW 文件生效或部门签收。

## 2. 层次化责任模型

每一次 G5/G6 受控证据提交均在同一 SERIALIZABLE 事务中冻结责任顺序：

- G5：按照**已发布模板的 `specialties` 数组顺序**依次形成专业责任，然后才是 `__gate__` 总复核；每项责任绑定自己真实的专业审核任务、指定审核人、提交号和冻结的 `policy_sha/manifest_sha`。
- G6：独立的一项 `__gate__` 第一次转移复核；不能复用 G5 的已通过意见。
- 服务端不接受客户端填报的“我是管理员”或“阶段审核已完成”；责任来自正式保存的模板、项目基线、真实账号、现有审核配置和冻结提交。
- **默认严格顺序**：前序任务状态不是 `reviewed`，后续专业不能直接记录意见。
- **有限的提前介入**：只有该提交明确定义的 `__gate__` 责任人、账号仍有效且项目/模板/基线仍活动，才能对另一名已分配专业审核人的特定**后续专业任务**记录一次有理由的提前介入。仅允许那个专业随后提前复核，不是将审核责任转交给 Gate。
- **中间责任不能被豁免**：在后续专业提前记录 `reviewed` 时，前序 `pending` 仍原样保留。总 Gate 无论是否存在提前介入，都必须等待所有专业责任最终 `reviewed` 才可以记录其“通过建议”；任何 `returned` 也不能偷偷算通过。
- 责任链和介入记录禁止事后 UPDATE/DELETE；同一目标任务只能对应一条介入事件；同一幂等键只能重放完全相同的介入请求。

## 3. DDL / 事务 / API

新增 `migrations/0051_dhf_pilot_sequential_duties_and_early_interventions.sql`：

- `dhf_pilot_review_obligations`：`task_id` PK、`submission_id + step_ordinal` 唯一、`submission_id + review_key` 唯一、审核人和双摘要绑定，并由 SQL 对比发布模板顺序验证。
- `dhf_pilot_early_interventions`：目标审核任务唯一、指派 Gate 责任人、原因、请求摘要、证据摘要、幂等键及时间；由 SQL 断言活动项目和活动模板基线、前序真实未完成、目标仍待审等条件。
- 前置触发器：未经有效介入，违反模板顺序的试点复核意见直接拒绝；缺少冻结义务不能伪造复核。
- 延迟约束：提交时必须**原子形成完整 G5/G6 责任链**；缺少任何任务/义务不得提交。
- 延迟约束：介入记录和 `audit_events` 必须同事务提交，不能写一条无审计来源的介入。
- 每次介入使用 `DHFPilotAuthorizeEarlyReview` 的 SERIALIZABLE 事务校验 Gate 责任人，锁定目标任务，验证身份/有效基线，插入不可变介入记录和审计事件后 Commit；相同请求可幂等重放，即便审核任务随后已经完成。

新增接口（统一工作台，不创建第二套审批）：

| Method | Path | 功能 |
|---|---|---|
| GET | `/api/workbench/dhf/duties` | 提供指定参与人的完整冻结责任顺序、各步状态、前序未完成数量、是否已经介入 |
| POST | `/api/workbench/dhf/tasks/{id}/early-intervention` | 指派 Gate 责任人指定目标任务、填写不可变原因与幂等键，登记允许提前开展专业复核；不是正式电子签署 |

原 `/approvals` 的“研发阶段审核”直接嵌入紧凑编号责任链，提供状态、前序义务和有限的提前介入登记；后续专业在被授权前不能从 UI 提交试点复核意见。原 Finder/ONLYOFFICE 文件审批、签章版本、CDW 受控发行与部门签收未更改。

## 4. 实际验收与审计负例

验收环境：`10.144.144.1` 独立 Git 检出，PostgreSQL 17 一次性数据库 `filesmanage_dhf_v063_integration_20261024`，真实文件 BlobStore；不能把前端构建通过当成浏览器人工验收。

| 断言 | 期望 |
|---|---|
| 53 项 migration 从空库执行并执行 `-check` | 无语法/校验偏差 |
| G5 责任顺序 | `G5-SW → G5-MF → __gate__`，与该测试已发布模板数组相同 |
| MF 抢先、无介入 | DB 事务拒绝 |
| SW 擅自授权 MF 提前审核 | 拒绝，非 Gate 人员没有 Gate 责任权限 |
| Gate 介入 MF | 必须有理由及唯一、不可变、审计一致的记录 |
| 同一介入键重放 | 返回原 ID，不重复审计和任务 |
| MF 提前“通过建议” | 仅 MF 状态变化；SW 仍 `pending`，总 Gate 无权通过 |
| SW 随后复核、Gate 最后复核 | 按责任完成；仅试点意见，阶段仍 `submitted` |
| 介入授权后目标和 Gate 都已复核的相同请求重放 | 仍返回原介入记录 |
| 直接 SQL 篡改义务或删除介入、伪造无审计介入 | 被拒绝 |
| 旧 G6 退回整改、新 Attempt、PDF/DOCX 固定页图和文件 ACL | 不发生回退 |
| 全套 Go/Vet、Vite、OpenAPI 和验收矩阵 | 实测退出码决定 PASS |
| 三种真实浏览器尺寸、法定身份签署、正式条件放行 | **NOT_RUN / BLOCKED** |

### 已取得的远端执行结果（2026-10-24）

| 远端执行项 | 实际结果 |
|---|---|
| PostgreSQL 17 全新一次性数据库迁移 | **PASS：53/53**，包含 `0051` |
| 真实 Go + PostgreSQL G5 顺序、提前介入和审计原子性用例 | **PASS**，`TestDHFPilotRealPostgresSubmission` |
| 无授权时 MF 抢先、非 Gate 授权、直接无审计插入、篡改义务和删除授权 | **PASS：均被拒绝** |
| MF 提前复核而 SW 仍为待办、Gate 等待 SW，完成后准确幂等重放 | **PASS** |
| G6 退回整改、新冻结 Attempt 和不可变链路 | **PASS**，同一真实数据库 |
| PDF/DOCX 真实受权固定 v1 页图和 v2 指针隔离 | **PASS**，`TestDHFPilotFrozenPDFDOCXRealPostgres` |
| `go test ./internal/... -count=1`、`go vet ./internal/...`、三项 Go 命令构建 | **PASS**，退出码 0 |
| `npm --prefix web run build` (TypeScript + Vite) | **PASS**，退出码 0；原有 Three.js chunk 体积警告尚存 |
| `python3 scripts/gen_openapi.py --check` | **PASS：135 paths / 164 operations** |
| `python3 scripts/gen_acceptance_matrix.py --check` | **PASS：126 IDs**（原有 123 PASS / 3 PARTIAL） |
| 真实浏览器桌面/笔记本/窄内容区与签署凭证测试 | **NOT_RUN**；不得据此声称 UI 已通过人工验收 |

测试均在 `10.144.144.1` 临时检出与一次性数据库中完成；V0.7.1 **没有对正式业务数据库迁移、切换服务或执行正式电子签署**。严格把工程回归 PASS 和企业业务授权/法定签章 NOT_RUN 分开。

## 5. 后续正式签审的不可绕过门禁

本版不会制造“正式签名”假象。进入正式生产 Gate 前还需新增：独立签名凭证和二次身份核验、由受权企业 SOP 发布的审核人/越级授权范围、每级决定与签名哈希、前序待签责任纠偏和期限、Gate finalization CAS/outbox、整改复验的具体证据闭环、CDW 独立受控发行、物理 Blob 保留/恢复以及真实 LAN 浏览器交互/安全验收。

**NO-GO：**不得将 `early_intervention`、`recommend_pass` 或已打开的整改案例直接作为正式签审完成或 Gate acceptance 的证据。
