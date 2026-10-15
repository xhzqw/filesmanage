# CDW G2 — 单文件任务/逐级责任内核实施与隔离验收

> 2026-10-15 · 阶段：**G2-Task-Pilot 已实现并完成针对性远端验证**；完整受控文件工作台仍 NO-GO。
>
> 本记录区别“任务事务内核通过”和“审批/ONLYOFFICE/发行/签收整体完工”。正式发行及部门签收尚未启用。

## 1. 实际代码

- `internal/ports/cdw_tasks.go`：CDW 专属事务端口、单文件任务/指派/义务 DTO。
- `internal/adapter/postgres/cdw_tasks.go`：PostgreSQL 根任务创建、活动主指派、接收 CAS、子任务派发、上级责任三联义务、任务/义务收件箱，领域事件、常规审计、outbox 和幂等回放均同事务。
- `internal/application/cdw_tasks.go`：服务器会话 actor 权限、文件 ACL 与现时任职、业务命令与内容摘要；纯技术 admin 仅允许建立根任务，不具备正式审批权。
- `internal/httpx/cdw_tasks.go`：新增四个 HTTP 路由；请求体拒绝未知字段、浏览器不得自报 actor；`Idempotency-Key` 和 `If-Match: "rev-N"` 分别要求显式发送。
- `migrations/0046_cdw_task_office.sql`、`0047_cdw_release_distribution.sql`：从 G1 草案提升的**新增、累加式**版本；既有迁移不改写。发行及签收 schema 准备就绪并不代表应用写命令已实现。
- `scripts/gen_openapi.py`、`docs/openapi-implemented.yaml`：同步新增路由的 OpenAPI 请求/响应、错误/头契约。

暂只支持**单文件任务**：创建根任务时不提供 `templateVersionId` 则原子初始化内置固定版任务模板。此模板不代表正式文件批准模板，也不得隐式发行。

## 2. 已实际验证的行为

| 场景 | 远端证据 |
|---|---|
| A 接收 → A 派 B → B 接收 → B 派 C | 独立 PostgreSQL 17 集成测试 `CDW_TASK_POSTGRES_PASS` |
| A/B 每次下派生成管理、整合、上报义务，均仍 pending | 数据库读取检查 6 项 pending |
| 同一任务两次同时接收 | 单成功、另一请求 CAS 版本冲突 |
| 同一幂等键、同请求 | 返回初始已提交的 taskId，而非新任务 |
| 同一幂等键、不同请求 | `ErrCDWIdempotencyReuse`，无新业务事实 |
| 非指派人/非组负责人接收 | `ErrForbidden` |
| 工作组负责人任职被撤销后接收 | `ErrForbidden` |
| 伪造 actor 或 actualReceiverId、额外 JSON、弱/缺失 ETag | HTTP 请求校验测试拒绝 |
| 连续两次运行真实 PostgreSQL 集成测试 | 两次 `PASS`，夹具无需清库 |

数据库门禁：专用隔离库 `cdw_g2_tasks_iso_20261015`，通过 root 主机下的 postgres 身份，用正式 `cmd/migrate` 从空库执行 49 份 migrations；随后 `-check` 确认全部 checksum。该数据库专供验证，不是现有 filesmanage 应用数据库。迁移和测试不删除/覆盖现有业务 DB/Blob。

远端 Go 全量回归 `go test ./... -count=1`、`go vet`、OpenAPI/验收矩阵生成一致性检查已有通过记录；最新提交补充的 HTTP 及隔离 PG 针对性测试单独重复确认。

## 3. 尚未完成 / 严格禁止误判为完成

1. `cdw_work_branches` 与 ONLYOFFICE 的单一保存入口/最终 callback fencing 尚未对接；**不能把普通 file_versions 视为工作分支修订**。
2. `delivery_freezes`、`delivery_items`、`review_gates`、正式授权越级决定和退回新轮次的 HTTP 命令尚未实现。数据库有字段不等于事务/权限已受控。
3. 文件夹固定清单与跨文件任务、依赖 DAG 编辑、动态流程模板、正式审批与候选稿、受控发行/签收、阅读/回收、生效指针解析、受控文件旧写入口隔离尚未完成。
4. 当前 `GET /api/workbench/inbox` 是权限过滤、限量只读列表，`nextCursor=null`；尚未实现游标分页、各类审批待办统一整合和 React RareUI 工作台。
5. 尚未在现有应用数据库应用 0046/0047，也**没有重新启动 18091 服务、部署新 API 或启用生产 8091**。运行的旧服务健康不证明本批 API 已上线。
6. 本期没有培训系统、培训率、培训生效门槛；部门签收与本人阅读确认保持独立。

## 4. 下一开发门禁

- 将 `TX-02` ONLYOFFICE 保存确认和分支版本追加接入独立 work branch；对协作迟到回调、force-save 不等于已持久、旧版本不可覆盖进行真实负例测试。
- 只有待交付分支最终保存屏障为 persisted 才能创建 delivery_freeze / immutable delivery_items；逐级 review gate 和授权越级将以**精确交付 SHA**为依据。
- 完成这条纵向事务线并远端浏览器验证后，再接正式受控候选审批 → 发行 → 部门签收（附人员阅读）与统一有效内容指针；正式发布仍需 G0 制度授权验收。
