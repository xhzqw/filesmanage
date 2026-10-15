# CDW G3 — ONLYOFFICE 工作分支与不可变交付冻结（隔离验证）

> 2026-10-15 · 实施状态：**后端纵向事务切片已通过针对性测试；完整受控文件工作台和浏览器集成仍 NO-GO**。
>
> 本阶段不修改 `migrations/0046`、`0047` 的已提交内容；使用上一阶段创建、由正式迁移工具校验过的专用 PostgreSQL 17 隔离库。**没有对现有应用数据库执行迁移，也没有重启正在运行的服务**。

## 1. 已实现

- `internal/ports/cdw_branches.go`：任务工作分支、ONLYOFFICE 会话、保存请求、回执和交付冻结的独立事务端口及 DTO。
- `internal/adapter/postgres/cdw_branches.go`：仅在现有 `UnitOfWork` 内操作。任务已接受的责任人可以创建基于精确 `file_version + SHA` 的分支；分支各自有 head revision、document key、edit epoch，不能改写 `files.current_version_seq`。
- `internal/application/cdw_branches.go`：服务器验证真实责任人、即时工作组任职与文件预览权限；会话配置复用唯一 ONLYOFFICE 编辑器和 JWT 签名实现，文件源由独立 branch-source 提供，不复用普通文件的 `office_sessions` 和 `appendVersionTx`。
- `internal/httpx/cdw_branches.go` 与 `router.go`：独立分支创建、会话建立、最终保存请求、保存状态查询、交付冻结与分支内部源/回调路由。
- `scripts/gen_openapi.py` 与 `docs/openapi-implemented.yaml`：实现路由与参数同步，当前合同共有 146 paths。

### 1.1 保存判定

- 可见编辑器保存按钮仍是 ONLYOFFICE 自身的保存；**没有在工作台发明第二个保存按钮**。
- 提交交付前的保存屏障通过签名 `/command` force-save 发起。命令响应 `error:0` 仅表示请求已接受；`requested` / `unknown` 都不能冻结。
- 保存请求 ID 绑定当前 authenticated user、分支、会话、幂等键，同一个请求可以重试；下载与验签不占有数据库行锁。
- 经回调 JWT 的 document key / status / URL（当签名携带该字段时）比对、现时 actor/ACL 和会话检查，才允许在事务内持久化专属分支 Blob/revision，更新匹配 request 为 `persisted`。
- 回调事务重新锁定分支和会话，检查 branch state、编辑 epoch、会话 generation、request 状态。重放不会创建第二个修订；主键包含 session ID，避免不同会话同 eventHash 冲突。
- 冻结前再次检查 `persisted` 回执必须指向该 branch 当前 head revision、epoch 与 SHA，不能存在其他未知/未完成保存请求；原子生成 `cdw_delivery_freezes`、`cdw_deliveries`、`cdw_delivery_items` 和首个直属上级 `cdw_review_gates`；原 branch 变 `frozen` 且编辑 epoch 前进。
- 创建分支与冻结交付由 `Idempotency-Key` 保护，同键同请求回放之前的响应；不同内容复用同键受 `cdw_operation_results` 限制。分支核心变更在事务内追加审计、`cdw_domain_events` 与 outbox。

## 2. 实证结果

| 验证 | 结果 |
|---|---|
| 现有任务 A→B→C 责任链，不因独立分支保存而减免 A/B 三联管理、整合、上报义务 | **PASS** |
| A、B 同一 file_version 的两个独立分支、各自持久化不同 SHA | **PASS** |
| 常规 `files.current_version_seq` 仍为 1；`file_versions` 行数不变 | **PASS** |
| 模拟 ONLYOFFICE `/command` 响应成功后，回调未发生前不允许冻结 | **PASS** |
| 同幂等键创建分支及重发 force-save 不生成第二个资源/保存请求 | **PASS** |
| 重放同一回调不重复追加修订；不同会话相同测试 eventHash 不发生主键冲突 | **PASS** |
| 已持久化并匹配当前 head revision 的交付冻结，包含确定 SHA 与直属上级待审 gate | **PASS** |
| 冻结后迟到回调不能修改 HEAD 或已冻结交付；不同幂等键无法重复冻结 | **PASS** |
| 同一冻结键重试回放原 deliveryId | **PASS** |
| 跨会话 callback JWT、源文件 token、签名状态/URL 不匹配 | **PASS（Go 负例）** |
| Go 全量 `go test ./... -count=1`、`go vet ./...` | **PASS** |
| 架构规则 `scripts/check_architecture.py`、OpenAPI 与验收矩阵一致性 | **PASS** |

后端数据库实测输出：`CDW_BRANCH_POSTGRES_PASS` 与 `CDW_TASK_POSTGRES_PASS`。验证目标是独立空库初始化的 `cdw_g2_tasks_iso_20261015`，只在此隔离库插入唯一测试 ID/样本，不清除现有任何用户数据或 Blob。

## 3. 本阶段明确不声称完成

1. **尚未在真实 ONLYOFFICE Document Server + Chrome 中**完成回调载荷格式、按钮实际保存、网络丢包、重连与大文件压测；当前 `/command` 被本地测试服务器模拟，回调入库通过服务端事务端口负例验证。
2. 当前是 **single-file + exclusive branch** 后端切片；协作共享 document key、分支权限细分和文件夹冻结资料包仍未落实。
3. `cdw_review_gates` 首节点能被创建，但**审核决定、授权越级审核、退回新轮次、最终合并与正式批准**的授权事务/API 尚未实现。不得因有 gate 数据就宣称逐级验收完整。
4. 未实现完整 `ResolveContent` 受控生效版本解析，未隔离所有普通文件旧编辑/预览写入口；正式发行、部门签收和人员阅读确认未上线。
5. 本轮只提交后端 API，没有 React RareUI 工作台或浏览器验收，未部署/重启开发服务器、未修改生产端口 8091。
6. 容错仍需真实网络/数据库并发场景扩测，例如临界冻结与回调抢锁、长编辑续约、ONLYOFFICE 回调异常、unknown 回执人工复核和恢复作业。

## 4. 下一批建议封闭门禁

- **G3.1** 以真实 ONLYOFFICE + 独立服务/数据库进行 HTTP 和 Chrome 端到端存储验收；修复 callback 令牌与企业网络交互差异，不牺牲签名/内容绑定。
- **G3.2** 实施 `review-gates/:id/decide` 和 grant 事务，授权越级不得免除上级 pending obligations；退回保持旧 delivery 只读，新的 round + branch + 独立修订必须重新保存/冻结。
- **G4** 在 `ResolveContent` 和旧入口封控通过后进入正式审批/受控发行、部门签收与阅读确认。
