# CDW G6 — 模板授权越级代验收 / 中间责任保留（2026-10-15）

> 状态：核心数据库事务及浏览器创建模板开关通过；部署仅限开发环境 `18091`，不能用于正式受控文件批准/发行。

## 决策和不变量

用户确认的方案 B：**允许授权越级介入，但不自动免除中间责任**。G6 范围仅为 `substitute_review_gate` 的**任务交付节点代验收**，不提供越级正式批准、免除义务、批量查看所有文件或自动签收。中间 `manage/integrate/report` 义务仍独立保持 `pending`。

- **默认不可替代**：内置普通单文件模板始终 `allowOverrideReview=false`。管理员派发根任务时显式切换“允许授权越级验收”，绑定独立 `published` 的不可变模板版本；所有子任务继承同一版本。新交付 gate 的 `substitutable` 在冻结时通过已发布模板 `role_policy` 决定。已经创建的旧普通任务不会被自动升级。
- **签发**：只能由该 gate 的现任直属审核人签发；目标只能是当前任务链上至少隔一级的**已接收任务**负责人，并仍有文件 preview ACL。一个授权绑定**一个 `gate_id` + 一个 `task_id` + 一个 `actor_id`**，只允许动作 `substitute_review_gate`，必填理由，有效期 24 小时，不能转用于另一任务、另一个交付轮次或正式审批。
- **事务边界**：签发时串行锁 task → gate，CAS gate revision，检查其 `awaiting/submitted`、模板开关、直属审核人现时资格、目标祖先身份及文件 ACL，持久化 grant、审计、domain event/outbox、幂等应答，统一提交；授权撤销由原签发人实施，留存 revoked_at。
- **代验收**：操作请求必须显式携带精确 `overrideGrantId`。同一事务重新检查 gate 的可替代性/轮次、原审核人的任职仍有效、grant 的 gate/task/granter/grantee/actions/有效期/撤销状态、本人仍是活跃任务链祖先，禁止仅凭 admin 或旧授权越权。`review_decisions.actor_id` 记录**真实执行人**，`acting_for_id` 记录原审核人，`override_grant_id` 绑定证据；验收通过 gate 状态 `substituted`，退回仍 `returned` 并将真实签发人作为退回指令的 `issued_by`。
- **幂等**：同一用户、同一 idempotency key 与完全相同请求可以回放，**包括 gate 已终结、grant 随后撤销的情况**。新请求必须重新鉴权；双 gate 决定不可能都成功。数据库部分唯一索引禁止同一 gate+actor 出现多个未撤销授权，防止“撤销 A 却留有 B”。
- **资源访问**：授权人在有效期内可访问该 gate 的真实冻结 DOCX（非普通文件 current_version）。撤销、到期或审核终结后，新请求失效。不能获得整个文件夹、额外文件版本或下游审批签署资格。

## API

- `POST /api/workbench/review-gates/:id/grants` — 直属审核人，`If-Match` + `Idempotency-Key`，`{actorId,reason}`。
- `GET /api/workbench/review-gates/:id/candidates` — task 祖先且 ACL 允许的人员。
- `GET /api/workbench/review-gates/:id/grants` — 签发者查看含撤销记录。
- `POST /api/workbench/review-gates/:id/grants/:grantId/revoke` — 幂等撤销。
- `POST /api/workbench/review-gates/:id/decide` — 新增可选 `overrideGrantId`（使用代验收时必须存在且匹配），返回 `actingForId` 与 `overrideGrantId`。
- `GET /api/workbench/review-gates/inbox` — 当前直属与**有效受权** gate。`reviewMode=direct|delegated`。
- `POST /api/workbench/tasks` — 增加管理员显式 `allowOverrideReview` 开关，缺省 false。

DDL：`0048_cdw_gate_bound_override.sql`、`0049_cdw_override_grant_uniqueness.sql`（增量、不改写 `file_versions`、`files.current_version_seq` 或历史签章）。

## 独立验证

- 专用 PostgreSQL 17 库 `cdw_g2_tasks_iso_20261015` 升级到 51 条迁移；`TestCDWTaskPostgresTransactions` 输出 `CDW_G6_OVERRIDE_POSTGRES_PASS`。
- 覆盖：默认模板不可替代、定向开启模板、A/B/C 责任链、非直属者签发拒绝、给 C/无关人签发拒绝、候选人范围、同 key 签发幂等、重复未撤销授权冲突、授权人待办、无 grant ID 的代验收拒绝、撤销后拒绝、过期后拒绝、假冒 grant 主体拒绝、代验收通过后原直属者无法再决定、相同授权审核请求的终结后幂等回放、真实 actor/acting_for/grant DB 三元证据、六项义务仍待履行、正式文件当前序号仍为 1。
- `bash scripts/build.sh`、`go test ./...`、Go vet、RareUI 组件治理、OpenAPI `157 paths`、验收矩阵检查均通过（以最终门禁为准）。
- 真实 Chrome 三宽 `1440/1024/780`，任务创建页越级开关默认 off，切换 on/off，无业务库写入；登录权限下任务/审核 inbox HTTP 200。
- dev DB `filesmanage_v21` 备份 `.backups/cdw-g6-20261015/pre-migration.dump` 已独立校验；迁移前后文件记录数量仍为 23131；仅开发端口 `18091` 更新，生产端口 `8091` 不触碰。

## 未完成

1. G6 实现的是**替代某一次任务交付验收**，尚无 `inspect`、`request_changes`、`escalate` 各自状态机，也没有挑战/申诉 `review_challenges` 的工作流。
2. 完整授权→另一用户登录→浏览器操作→实时页面通知的多身份 UI 端到端尚未跑；服务端授权/撤销/拒绝与 G5 真正 Office 保存测试独立通过。不能据此宣布整套正式 CDW GO。
3. G7 必须实现独立正式文档批准、不可变 release 清单、生效指针、受控分发、部门签收 + 指定人员阅读确认、回收旧副本；不得混用任务交付验收与文控审批。培训模块/培训率继续不纳入当前项目。
