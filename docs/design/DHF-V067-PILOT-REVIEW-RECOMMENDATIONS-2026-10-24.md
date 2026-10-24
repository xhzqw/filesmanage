# DHF V0.6.7 — 专业复核意见、阶段总 Gate 顺序与试点审计

> Document ID: DHF-ENG-REVIEW-20261024-01  
> Version: V0.6.7 development draft · Date: 2026-10-24  
> Status: **开发分支隔离验证；NOT a controlled official release or electronic approval**  
> Branch: `feat/dhf-v06-gate-pilot` · GitHub PR #1  
> Governance baseline: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`, `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`.

## 1. 责任和原始来源

本阶段承接原始 XMind DHF 九阶段受控来源，按真实 G5“设计开发输出”和 G6“第一次设计开发转移”区分。XMind 叶节点仍为待裁决候选，而不是自动的必交文档集合。G5 专业审核键、审核人及最终总 Gate 仅从已发布的项目模板及明确的审核责任配置派生。现存文件版本审批属于 CDW，不与 DHF 的项目/阶段/提交实例共用正式批准状态。

**本版决议边界：**审核人可以提交“通过建议”或“退回建议”，其本质是试点意见，不是电子签名、正式阶段通过、条件放行、文件生效或部门受控签收。项目阶段仍为 `submitted`。

## 2. 实现范围

### 2.1 领域事务

- `DHFPilotRecommend` 使用新 SERIALIZABLE 事务，重新从数据库读取真实用户身份、项目成员及明确任务受让人；不能使用客户端自报管理员或审核角色。
- 意见与 `task_id`、`submission_id`、`reviewer_id`、`policy_sha`、`manifest_sha`、`idempotency_key`、`request_sha` 固定绑定。
- `recommend_return` 必须包含明确理由；评论长度最多 2000 个 Unicode 字符。评论和动作相同且幂等键相同的重试返回旧决定，不再写入。
- 只允许 `pending → reviewed` 或 `pending → returned`。已决定任务不能被第二个人接管、覆盖、修改历史或直接回退为待审。
- G5 的 `__gate__` **通过建议**必须等待该提交全部专业任务达到 `reviewed`；提前尝试会完整失败。总 Gate 仍不能把阶段设置为 `accepted`。

### 2.2 数据库与审计

`migrations/0049_dhf_pilot_reviewer_recommendations.sql` 包含：
- `dhf_pilot_review_decisions` 不可变审计主记录；
- 当前任务、冻结提交哈希、真实用户、项目活性与模板发布状态校验；
- G5 总 Gate 顺序阻断；
- 审核意见插入及对应任务状态转换的双向提交约束；
- 与业务决定同一事务内追加 `audit_events`，失败统一回滚。

业务历史不会通过更新旧记录实现改派、撤销或越级。正式授权跳级必须在后续独立的逐级责任链状态机中追加审批事件，不免除中间责任。

### 2.3 工作台及接口

- `GET /api/workbench/dhf/tasks`：只读当前审核人待处理任务及 `gateReady` 提示。
- `POST /api/workbench/dhf/tasks/{id}/recommendation`：仅提交本人试点复核建议，输入 `outcome/comment/idempotencyKey`，返回 `trialOnly=true`。
- 统一 `/approvals` 工作台新增专业意见输入和建议按钮，保留原文件编辑/回滚审批。
- G5 专业未全部通过时禁用总 Gate 的“通过建议”；“退回建议”必须输入原因。
- 网络结果不确定时，客户端对**完全相同的任务、动作和意见**保留原幂等键后重试；不得因为刷新按键就产生不同逻辑动作。
- 前端明确声明：此页面没有将普通文件预览冒充冻结证据审查，尚未提供正式电子签署能力。后续必须增加固定版本的安全预览和强溯源查询。

## 3. 实际远端验收

全部命令在 `root@10.144.144.1` 的独立临时检出与仅供 DHF 测试的 PostgreSQL 数据库中执行。与生产 `main` 和业务数据库隔离。

| 验证 | 结果 | 证据/说明 |
|---|---|---|
| `go test ./internal/... -count=1` | **PASS** | 提交 `c2feed1` |
| `go vet ./internal/...`，Server/Worker/Migrate 构建 | **PASS** | 提交 `c2feed1`，退出码 0 |
| PostgreSQL 17 原生迁移器空库执行 | **PASS** | 51 个迁移；修正了 0049 的 PL/pgSQL CASE 解析歧义 |
| Go + PostgreSQL 真实 `TestDHFPilotRealPostgresSubmission` | **PASS** | G5 专业先审与总 Gate、越权/自审拒绝、幂等重放、G6 退回、不可变性 |
| OpenAPI 接口生成器 `--check` | **PASS** | 新接口、`gateReady` 与意见返回 schema 一致，共 127 paths |
| 企业已有验收矩阵 `--check` | **PASS** | 126 条声明，123 PASS / 3 PARTIAL，原未完成项仍保留 |
| 真实浏览器桌面/窄屏与读附件审批 | **NOT_RUN** | 本版未声称 UI 业务验收或签署 |

## 4. 明确缺口与发布阻断

1. 正式电子签署身份/凭证、独立审核人与多级主管责任链，允许授权越级但不自动豁免中间责任。
2. 固定文件版本受权预览、证据复核、合法引用关系、审阅意见与具体证据的双向溯源。
3. 专业意见后的整改/退回新尝试、正式 Gate 汇总接受/拒绝事务、CAS/outbox、签章与受控发行分离。
4. 模板版本发布和真正的企业 SOP 验收，原 XMind 项目的必交范围、责任人及 G6/G8 依赖仍需有权人员核准。
5. 浏览器三档尺寸实测、真实 LAN 集成负载、恢复与保留、正式发布回归。
6. 所有以上未满足前 PR 保持 **Draft/NO-GO**。不可因试点 `reviewed` 推导 `stage.accepted` 或视作法定审核批准。

**技术结论：** V0.6.7 交付的是有审计、有幂等、有授权和强证据哈希绑定的**试点复核意见事务**；没有打通正式 DHF 阶段决议及受控文件发行。
