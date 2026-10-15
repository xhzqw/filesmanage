# CDW-VERSION-OFFICE-CONTRACT-v1.1 — 工作分支、ONLYOFFICE 保存与内容版本解析

> 隶属：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md`。本合同为拟实现设计，不代表现有 Editor 行为已经隔离。
> G1 字段与保存屏障以 `CDW-G1-DDL-01-TASK-OFFICE.sql` 和 `CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md` 为准。用户可见保存只用 ONLYOFFICE 本身入口；业务前端“提交交付”不等于“保存文件”。

## 1. 当前实现与冲突点 [L]

- `internal/application/office.go:55–121`：按 file_id 开单一会话，现有其他用户活动会话阻塞，新 document_key 按 file_id + base_seq + 随机代号构造。
- `internal/application/office.go:493–583`：保存回调对 `currentSeq(file)` 做 CAS，然后 `appendVersionTx` 修改正式文件历史；因此**当前 Save 不可直接作为任务工作分支持久化**。
- `internal/application/approvals.go:255–303`：最终正式批准后追加 file_versions 且更新 files.current_version_seq。
- `internal/application/files.go:254–282`、`preview.go:148–166`、`print.go:23–43`、`indexing.go:102–149`、`seal_download.go:11–47`：当前路径从 `currentSeq(file)` 读取，不能在受控版模式下盲用。
- `internal/application/office_changes.go` 的 DOCX 语义差异按段落序号定位，不能当作可靠的自动合并键。

## 2. 单一版本解析器（P0-B）

定义纯业务入口 `ResolveContent(fileId, purpose, actor, resourceContext) -> ResolvedContent`。解析发生在后端，必须再次核验有效权限。

| purpose | 默认选择 | 必需上下文 |
|---|---|---|
| normal_preview / normal_download / normal_print（受控） | 当前适用范围的 effective release **最终发行物** | scope、当前发行资格 |
| normal_preview / download / print（普通非受控） | 兼容 current_version_seq | 原文件 ACL |
| approval_review | 被批准节点/候选稿绑定的 Blob | approval_id、正式审批角色 |
| task_edit / task_preview | 指定 work_branch 的 latest durable revision | branch_id、task_id 与 branch ACL |
| distribution_receipt | batch item 冻结的 release artifact | target_id、batch_item_id、授权接收人 |
| personal_reading | assignment 绑定的发行版本/哈希 | reading_assignment_id |
| release_preparation | 已批准候选/其待验证发行物 | release_draft_id、文控授权 |
| history | 指定不可变 version_id 或 release_id | 历史访问授权，不允许仅用 current 指针 |

`ResolvedContent` 响应必须包含 `kind, file_id, version_id?, branch_revision_id?, release_id?, artifact_id?, blob_id, sha256, content_type, display_name, effective_scope, is_current_effective, permissions`；不允许只有文件名和 `vN`。

### 2.1 所有入口审计清单

| 路径 | 变更策略 |
|---|---|
| /files/:id/preview 与 preview/media | 非受控保持旧行为；受控 normal 指向当前有效发行物 |
| /files/:id/download、批量下载 | 单次请求固定版本解析结果，下载与审计哈希一致 |
| /files/:id/print/prepare、print/media、office-pdf | 整个打印管线绑定同一解析结果/nonce，不在二次媒体请求中偷换最新版本 |
| PDF/Office 页转换及衍生物缓存 | cache key 含 release_artifact_id + sha256 + converter_version，转换错误不回退 latest |
| seal/export | 正式受控发行只返回冻结物，不动态读取最新 seal revision |
| search index / snippet | 对普通用户只检索有权限的当前受控内容；工作分支另索引且 ACL 隔离 |
| shares / favorites / 文件历史 | 显式区分引用 file_id 与指定 release_id；历史链接不会偷偷指向新版 |
| WebSocket 文件事件 | 只触发缓存重取，不能决定本地当前受控版内容 |
| office editor source | 通过 branch_id + revision/snapshot 而非 file.currentSeq 返回内容 |

**安全默认**：已受控但无合法 effective release 时普通执行读取返回 `no_effective_release`，不回退最近批准/上传版；具有草稿授权者通过明确工作/审批上下文访问。尚未纳管的普通文件继续走原非受控规则。

## 3. 工作分支与编辑会话模型（P0-C）

| 表 | 字段 | 约束 |
|---|---|---|
| work_branches | id、file_id、task_id、base_version_id、base_sha256、head_revision_id、collaboration_enabled、state、revision、created_by | 同文件可多 branch；一个 branch 明确对应责任任务 |
| work_branch_revisions | id、branch_id、ordinal、parent_revision_id、blob_id、sha256、byte_size、actor_id、saved_at、save_event_id | UNIQUE(branch_id,ordinal)；只能追加 |
| office_branch_sessions | id、branch_id、document_key、owner_id、generation、state、expires_at、base_revision_id、collaboration_group_id 可空 | 非协作：同 branch 单写会话；协作：同 branch 共享同一 doc key 和受控参与者 |
| office_branch_save_requests | id、session_id、request_nonce、session_generation、requested_at、state、receipt_revision_id、completed_at | force-save 需明确 persisted receipt |
| office_branch_callbacks | id、session_id、event_hash、status、artifact_sha256、outcome、occurred_at | UNIQUE(session_id,event_hash) 防重放 |

### 3.1 重要：ONLYOFFICE 不是文件编辑分支引擎

真正的分支隔离由 filesmanage 的数据库与 Blob 存储实现：ONLYOFFICE 只管理某一 `branch_id` 对应的实时编辑会话。**禁止复用现有 file_id 单写会话和 appendVersionTx 来存任务草稿。**

- 不同 branch：不同 document_key、不同 head_revision、不同保存回调目标，可并行。
- 同 branch 协作：负责人明确开启、成员被授权加入；所有参与者必须被后端映射到同一个协作文档键/会话语义，不能逐人生成破坏协作的独立 key。
- 非协作：同分支同一时刻一名编辑者有写入租约；其他人可获独立分支或只读快照，不能偷偷抢锁。
- 活动任务分支不得继承被授权者以外的正式审批权限。

### 3.2 会话保存状态机

`open → save_requested → callback_received → persisted → frozen_for_delivery`。失败路径：`save_requested → timed_out / failed`；迟到回调需用请求代号 + generation + 内容基准重新验证。

1. 客户端点击“保存”→ 服务端创建唯一保存请求和 `request_nonce`，向 ONLYOFFICE force-save 发请求。
2. ONLYOFFICE 命令成功只代表**已接受请求**，不得显示“内容持久化成功”。
3. 经 JWT 验证且 URL 通过既有 SSRF 限制、对应 session/generation/key 的回调下载产物，校验字节/类型/大小/哈希。
4. 下载过程不持有数据库行锁；取得完整字节后开启事务，锁 branch+session，CAS head_revision + session_generation，检查成员权限/冻结状态，追加 work_branch_revisions、回调事实、保存 receipt 与私有 outbox。
5. 客户端通过 `GET /api/work-branches/:id/save-requests/:requestId` 轮询（或实时失效后重取），只有 `persisted` 才准许冻结交付。
6. 超时结果 `unknown/pending` 时提示待确认，不能让用户连续保存产生互相覆盖的分支；幂等请求必须可查询。
7. 一旦交付冻结，delivery 引用该 revision_id + Blob + 哈希。迟到回调不得改变已交付内容，可在授权情况下另建分支修订，但不能覆盖交付快照。

### 3.3 冲突与合并

- 两个任务分支可来自同一基准版，但其 head 不互相覆盖；整合时在 `integration_candidate` 中显式选定来源 delivery 项、冲突解决决定与输出最终 Blob。
- DOCX 仅可使用语义 diff 进行辅助定位；现有段落序号不保证稳定，**禁止未经人工确认自动语义合并写入正式文件**。
- 整合候选冻结 `base_version_id / participating_delivery_ids / integration_blob_sha256 / resolution_evidence`，再进入正式批准；审批后严禁改写候选内容。
- 与转换 PDF 的 lineage 采用源 version/revision、转换 job、目标 blob sha 关系；不能用同文件名当血缘证据。

## 4. 版本命名与正式受控版次

| 字段 | 意义 | 能否修改 |
|---|---|---|
| file_id | 文件身份 | 不可变 |
| file_versions.seq | 原有正式历史递增序号 | 不可变 |
| work_branch_revisions.ordinal | 某工作分支修订序号 | 不可变 |
| version_display_name | 用户自定义语义版本名（如“二轮审查稿”） | 允许修改，保留更名审计和同名提示 |
| controlled_revision | 发行标识 A/1 等 | 发行后不可变，编号规则 [V] |
| release_artifact.sha256 | 最终发行物字节哈希 | 不可变 |

允许更名不等于允许修改已发行文件名快照。应保留 `display_name_snapshot` 和 `renamed_at/by` 事件，不允许以改名逃避历史批准、回收和签收证据。

## 5. API 草案

- `POST /api/work-branches`：`{fileId, taskId, baseVersionId, collaborationEnabled:false, idempotencyKey}` → `{branchId, revision, state}`。
- `POST /api/work-branches/:id/office-sessions`：`{mode:"exclusive"|"collaborative", expectedRevision}` → `{sessionId, documentKey, editorConfigJwt, expiresAt}`。
- `POST /api/work-branches/:id/save`：`{sessionId, expectedRevision, idempotencyKey}` → `202 {requestId,state:"pending"}`。
- `GET /api/work-branches/:id/save-requests/:rid` → `{state:"pending"|"persisted"|"failed", savedRevisionId?, sha256?, errorCode?}`。
- `POST /api/work-branches/:id/freeze-delivery`：`{taskId, branchRevisionId, expectedRevision, idempotencyKey}` → `{deliveryId,contentHash}`。
- `POST /api/integration-candidates`：`{fileId, baseVersionId, deliveryIds[], resolutionSummary, idempotencyKey}` → 冻结候选稿。
- `GET /api/files/:id/content-context?purpose=normal_preview` 返回受控的解析元数据及 allowed_actions，不暴露未经授权的工作稿。
- `GET /api/controlled-releases/:id/artifacts/:aid/content`：以 release/ACL 限定下载的冻结物，禁止从文件当前版重解析。

## 6. 负面验收

- V-01：B、C 两分支同 base 同时保存，互不覆盖，file_versions/current_version_seq 不变。
- V-02：force-save 仅确认命令，交付按钮仍禁用；回调持久化后才可交付。
- V-03：同会话多次回调、超时重试、代际错位与旧 callback，不重复生成修订。
- V-04：同 branch 协作开启前第二个编辑者不能静默加入；开启后共享正确 doc key。
- V-05：分支被冻结后晚到回调不能替换原交付 Blob。
- V-06：审批通过 A/2 但未生效时普通预览、下载、打印、搜索仍返回当前有效 A/1（仅依权限）。
- V-07：没有有效受控版本时，普通读取返回明确禁止而非悄悄 latest。
- V-08：DOCX→PDF→签章、内容比较和打印均绑定正确 revision/artifact 哈希，不通过文件名猜来源。
- V-09：已有无管控普通文件下载仍兼容现行为，不被误判为无有效受控版。
