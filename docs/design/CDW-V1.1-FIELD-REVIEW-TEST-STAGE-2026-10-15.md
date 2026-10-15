# CDW V1.1 字段级工程审查 — 测试阶段 Clean Start

> 日期：2026-10-15  
> 适用范围：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md` 及四份分领域合同。  
> 审查性质：本地代码/规格静态证据 + 设计推理；**不是完成实现/DB 迁移/远端验收的证明**。  
> 用户最新边界：**系统还处于测试阶段；旧测试数据无需迁移、回填、对账或长期兼容**。  
> 本报告仅审核与建议，不修改业务代码、不执行 migration、不清库、不提交部署。  
> 严重程度：P0=进入依赖模块编码前应关闭的模型/安全/一致性问题；P1=开始跨模块联调前关闭；P2=体验/运营补充。  

## 0. 审查总评

- **产品原则通过**：默认逐级派发、授权越级不豁免责任、独立分支优先、工作组负责人承接、固定文件夹清单、验收/正式审批/发行/签收/生效分离；不增加 PDF 没有规定的培训率。
- **总体架构需修订后可开发**：当前 V1.1 描述了对象和主流程，但**尚未冻结可执行的 DDL、复合外键、唯一约束、事务边界、ONLYOFFICE 保存屏障和 API 统一格式**。
- **历史数据迁移不再是阻断项**：删去 legacy backfill、legacy_validated、legacy_controlled_baselines、旧事件推定、旧 release 和旧表投影的实施任务；不影响新系统数据不可变、安全删除和备份基础要求。
- **推荐 Test Clean Start**：保留普通文件存储/ACL/版本基础能力，直接替换旧审批/生命周期的受控领域权威写入口。不维护两套受控发布状态。开发测试库如需重置，先做库身份/环境/备份防误操作检查，**必须取得单独的数据删除授权**；本轮绝不清理任何实际 DB 或 Blob。

## 1. 源码核对事实 [L]（以当前工作树 a9d3152 为准）

| 路径/位置 | 确认事实 |
|---|---|
| `migrations/0001_core.sql:49–92` | files.current_version_seq 指向 file_versions；`uq_pending_approval` 同文件只能有一个旧式 pending 审批 |
| `migrations/0018_approval_chains.sql:2–8` | 旧审批链数组约束 1..5 人 |
| `internal/application/approvals.go:201–215,255–303` | approve 可让管理员绕过指定 approver；最终批准追加 file_versions 且更新 current_version_seq |
| `internal/application/file_lifecycle.go:93–143,195–220` | publish 依据修改权限等检查，而非正式批准和受控发行凭证 |
| `internal/application/office.go:55–121,393–585` | 编辑会话按 file_id 锁；保存回调调用 appendVersionTx；force-save 命令成功并不意味着持久化 |
| `internal/application/office.go:317–347` | 现有 ONLYOFFICE 原生保存回执计数机制，不能忽略已有单保存入口优化 |
| `migrations/0001_core.sql:13–21` | workgroups 仅部门及成员；并没有正式的工作组负责人有效任职表 |
| `migrations/0012_management_role_bindings.sql:2–16` | 管理角色仅 auditor / permission_admin，不是业务批准/文控/工作组负责人身份 |
| `migrations/0028_durable_realtime_events.sql:5–29` | 当前实时事件依赖事务内持久写入和通知，适合复用匿名失效/用户私有事件模型 |
| `cmd/migrate/main.go:43–87` | schema_migrations 按迁移**完整文件名与 checksum**核验；更改已应用 SQL 会校验失败 |
| `internal/httpx/errors.go:13–56` | 已有统一 JSON `{ok:false,error:{code:"E_*"}}`；新 API 不得再造不兼容的错误包 |

若后续代码提交使行号漂移，必须以新 HEAD 重审，不把本报告写成运行端事实。

## 2. P0 审查发现及建议裁决

| ID | 类别 | 缺口 | 必须执行的设计修订 |
|---|---|---|---|
| P0-01 | 正式审批 | `approved_candidates(version_id,approval_id)` 含义/创建时序含混，候选稿在审批前不一定有正式 version_id | 分成 `approval_subjects`（已冻结的待审 Blob）、`formal_approval_instances`、`formal_approval_steps/decisions`、`approved_candidates`（审批通过后的结果）。approved_candidates 只能由通过后的确定 subject 派生，subject hash 永不变 |
| P0-02 | 已生效指针 | `effective_pointers PK(file_id,scope_id)` 阻不住不同 scope 重叠，且 pointer 与 controlled_releases.state 都表达 effective | **建议 V1.1 第一阶段仅一个全局生效范围**：`effective_pointers(file_id PK, release_id?, state, revision)`；未来厂区/生产线分范围生效另开 ADR。pointer 是权威，release.state 是同事务可重建投影 |
| P0-03 | Office 编辑 | session 没有参与者关系，`session.owner_id` 不能表示多作者协作；保存事件可能混淆工作分支和正式版 | 增加 `office_branch_participants`、branch 权限与同 document_key 协作会话。回调**只能写 branch revisions**；冻结交付引用具体修订，不可写 files.current_version_seq |
| P0-04 | 保存屏障 | `save_requested→persisted→frozen` 没处理“持久化后又有未保存修改”、并发多人、晚到回调和编辑器正常结束 | 将 `office_save_requests` 与 `delivery_freezes` 分离。冻结前封住该轮编辑权、确认最终 callback/status2 或匹配 generation 的持久保存收据、检查无未决可覆盖保存；冻结创建精确 head_revision/sha；后续保存必须开启新轮次 |
| P0-05 | 资料包审批 | `distribution_scope_approvals.manifest_hash` 只有 preparation ID，`distribution_batch_items` 在其后创建；未保证批准目标和实际派发完全相同 | 将范围审批绑定 **frozen distribution plan digest**，内容含已批准部门、电子/纸质方式、数量、批次 items 的 release/artifact ID + hash。派发事务必须重算并比较同一个 digest，不相同则重新确认 |
| P0-06 | 资料包跨表一致性 | 现有逻辑表无法单凭 FK 防止 target_item_requirements 指向其他批次 item，或 artifact 指向非所属 release | 用包含 batch_id / release_id 的复合外键：`(batch_item_id,batch_id) → batch_items(id,batch_id)`、`(target_id,batch_id) → targets(id,batch_id)`、`(release_id,artifact_id) → release_artifacts(release_id,id)`，配 UNIQUE 满足引用 |
| P0-07 | 签收凭证 | `department_receipts` + `target_receipt_heads` 是正确方向，但 `ack_state`、head、事件能漂移；多签场景缺少 obligor | **V1 先固定每部门一位授权实际签收人（代理可替代）**，显式 `receipt_obligations` 若未来要会签；同事务锁 target + head、授权校验、插凭证、更新 head/ack_state、写事件/outbox；不可直接更改原凭证 |
| P0-08 | 版本访问 | `ResolveContent` 合同正确但缺可执行鉴权与不可变上下文的二次读取条件 | 对 preview/download/Range/print/search/office source/seal export 使用同一解析结果 `artifact_id + sha256 + purpose + auth_epoch`；二次 URL 仍重验当前权限与指定 Blob，不能重解析“最新” |
| P0-09 | 法定受控行为隔离 | 旧 publish/Approve 含可绕过新系统的逻辑；测试环境没必要保留受控领域双权威 | 可直接让新版受控文件写操作只走新的 application commands；**不是删除原通用文件能力**。旧受控 publish/approval 写端需统一拒绝或显式转新命令，不再同步两份业务状态 |
| P0-10 | 强制制度节点 | 分发范围审批、发行内容哈希、正式角色、生效策略没有一致的事务锁/审计语义 | scope approval 不能是只有 boolean 的勾选；快照需批准人、角色资格、digest、时间、发行物清单、校验版本。issue/dispatch 必须重新核验有效快照及授权 |
| P0-11 | 发行 ID 时序 | 分发计划摘要需绑定 release_id/artifact_id，但原规格在分发范围批准后才创建正式 release，形成前后依赖冲突 | 准备阶段**预先分配稳定 release_id**、创建 state=preparing 的 release 与暂存 artifact；范围确认绑定该 ID 和最终冻结 artifact 摘要；issue 仅使同一个 release 进入已发行状态，不得另创替换 ID |

## 3. P1 审查发现及修订目标

| ID | 问题 | 推荐修订 |
|---|---|---|
| P1-01 | `tasks.current_assignee_id` 和 `task_assignments` 两套当前责任人 | `active task_assignment` 作为唯一权威；tasks.current_assignee_id 如保留只能作同事务投影，必要时可不存 |
| P1-02 | `task_assignments.assignee_id/group_id` 双可空 | CHECK 正好一个有值，分别建 FK；group 的当前负责人以有效角色绑定/当次接收角色快照解析 |
| P1-03 | 工作组负责人没有数据源 | 新增 `workgroup_role_bindings(group_id,user_id,role,valid_from,expires_at,revoked_at,granted_by)`；不把 permission_admin 冒充组负责人 |
| P1-04 | `deliveries` 和 `delivery_items` 同时持久化单文件 Blob | 统一以 delivery_items 为内容权威；deliveries 只存任务、轮次、提交者和清单 digest；单文件也是 1 个 item |
| P1-05 | parent/root、依赖环和关闭条件只有文字约束 | 加本级任务树根不变量、父子环/依赖环事务校验，关闭必须满足所有必需子任务 gate + accountability_obligations |
| P1-06 | 退回/拒绝后的状态不完整 | 为 declined 指派定义重新派发/撤销；return_orders 明确目标与轮次，重新提交创建新 delivery，不覆写上一轮 |
| P1-07 | `target_receipt_heads` 与 `department_receipts` 之间 FK 循环/唯一性不完整 | head 的当前收据 FK 必须指向**同一 target**，可用复合 FK + nullable / deferred；不依赖 UPDATE receipt 的“已撤销”字段 |
| P1-08 | 已发行 Blob 主产物 `is_primary` 未定义多格式选择 | 定义唯一 `(release_id,distribution_format)` 主产物，按分发计划冻结; DOCX/PDF 实际签收的是哪个 artifact 必须单一确定 |
| P1-09 | `distribution_batches` 至少一项不能用普通 CHECK 保证 | 草稿阶段允许空，`freeze/dispatch` 事务在锁内要求 item >=1，冻结后拒绝增删；可辅以延迟约束触发器 |
| P1-10 | 纸质 issue_lot 数量与逐份 copy 数无法用简单 CHECK 保证 | 发放批次 `draft→frozen` 事务锁下比较发行数量与 copy 行数；冻结后只允许追加回收事件 |
| P1-11 | ID、hash、状态集合及 FK 仍是文字模型 | 采用 `NOT NULL + CHECK + FK + UNIQUE + partial unique + DEFERRABLE` 的字段级真实 DDL，hash 校验 64 hex，角色关系必须 FK 实体 |
| P1-12 | `Idempotency-Key` 在 HTTP header 与 JSON body 两套表达 | 统一**请求头** `Idempotency-Key`；数据库索引 (actor, operation, key)，存 request_sha256 + response/status；同键不同参数 409；不同键也由业务唯一约束防双签 |
| P1-13 | `If-Match/expectedRevision` 两套 CAS | 统一用 `If-Match: "rev-N"` 的强 ETag，或统一 body 字段，推荐头。成功回 `ETag`。禁止 header 与 body 值不一致 |
| P1-14 | 现有后端错误合同为 `ok/error.code` | 保持外层结构，新增 `E_CD_...` 业务码，具体区分不可生效、保存未确认、越级不授权、分发摘要冲突 |
| P1-15 | `office_save_requests` 以 session_id owner 限定，与协作身份冲突 | 保存状态查询校验**参与者或负责人资格**，收据指向发起 actor/request 和关联 generation，不把协作者误判无权 |
| P1-16 | 发行状态、pointer、任务状态多份可写投影 | 每个聚合给出**唯一 authority table/event 和受控写命令**，前端 aggregate 均由查询生成，不能允许各端口直接 UPDATE state |
| P1-17 | 受控发行时间达到但无审批/签收前置条件 | 调度只触发条件重验，数据库原子切 pointer；无合法有效版返回 `no_effective_release`，不自动回退最近的历史版本 |
| P1-18 | 阅读确认措辞可能暗示“已读就真正理解” | 明确仅为本人知悉确认；首次访问/阅读完成/培训互不替代，**无培训率** |
| P1-19 | 当前文件审查批注锚点绑定 file_id + version_seq，无法正确绑定并行 branch 或冻结 approval subject（见 `internal/domain/file_review.go:17–42`） | 通用批注增加明确的 subject_kind + subject_id（branch_revision / delivery / approval_subject / release），存目标版本哈希与页/文本锚点快照；重排/转换后的定位须显式映射，禁止批注漂移到另一分支 |

## 4. 建议的 V1 PostgreSQL 最小约束（逻辑 SQL 示范，非可执行迁移）

> 以下片段表达关键不变量，具体表字段、引用对象与分批创建顺序须在 DDL 冻结评审进一步敲定。不要把片段直接在真实库执行。

~~~sql
-- 统一受控执行版。V1 全局，不支持相互重叠的区域 scope。
CREATE TABLE effective_pointers (
  file_id text PRIMARY KEY REFERENCES files(id) ON DELETE RESTRICT,
  release_id text,
  state text NOT NULL CHECK(state IN ('active','none')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision >= 1),
  activated_at timestamptz,
  CHECK ((state = 'active' AND release_id IS NOT NULL)
      OR (state = 'none' AND release_id IS NULL))
);
-- 后补复合 FK：(file_id, release_id) -> controlled_releases(file_id,id)

CREATE TABLE task_assignments (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  assigner_id text NOT NULL REFERENCES users(id),
  assignee_id text REFERENCES users(id),
  group_id text REFERENCES workgroups(id),
  kind text NOT NULL CHECK (kind IN ('primary','support')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  CHECK ((assignee_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX uq_task_primary_live
  ON task_assignments(task_id) WHERE ended_at IS NULL AND kind='primary';

-- 每一冻结批次至少 1 条 item，在服务器 freeze 事务里验证。
CREATE UNIQUE INDEX uq_distribution_item_ordinal
  ON distribution_batch_items(batch_id, ordinal);

-- 哈希为 lowercase hex；各表同类字段均强制验证。
-- CHECK (sha256 ~ '^[0-9a-f]{64}$')
~~~

### 4.1 需要补齐的约束清单

- `approved_candidates`：唯一 `approval_instance_id`、`subject_id`、`subject_sha256`，且 approval 已实际完成所有强制审核节点。
- `release_artifacts`：`(release_id,id) UNIQUE` 供复合 FK；发布后引用的 Blob 不可 UPDATE/DELETE。
- `batch_items`：`(id,batch_id) UNIQUE`，`artifact_id` 对应同一 release；冻结后不能修改/删除。
- `targets`：`(id,batch_id) UNIQUE`；发行范围确认必须验证实际 target 集合的 hash 一致。
- `target_item_requirements`：冗余 `batch_id` 并通过两组复合 FK 强制该 target/item 属同 batch。
- `department_receipts`：`(target_id,id) UNIQUE`、原始行只追加；`target_receipt_heads(target_id,current_receipt_id)` 外键固定同 target；同事务维护有效指针。
- `work_branch_revisions`：`UNIQUE(branch_id,ordinal)`、`CHECK(size_bytes>=0)`、`sha256` 格式检查、head CAS。
- `review_decisions`：同 gate/round 必需唯一最终合法决定；越级所引用的授权 grant 必须在事务时点有效。
- `copies`：每个 release 的纸质副本编号唯一、每份只能形成一次有效收回，撤销必须另行追加纠正事件。
- 新业务证据 FK **默认 RESTRICT**；即使测试期数据可以整体重建，也不允许通过普通 UI 删除文件连带抹掉不可变审查和签收证据。

## 5. 五条必须冻结的事务路径

### TX-01 执行任务逐级派发 / 越级验收

1. 锁 root/task 当前分配与 gate，CAS Revision，检查组织身份/授权 grant 是否有效。
2. 检查父子关系、依赖 DAG、固定清单一致性；有新子任务则保留上级 `accountability_obligations`。
3. 新建 assignment/child task 或追加不可变 review_decision；越级只替代可替代 gate，不能自动关闭所有父级责任。
4. 写审计 + 私有 outbox → commit；重试同一幂等键只返回第一次结果。

### TX-02 ONLYOFFICE 持久保存 → 冻结交付

1. 编辑器唯一可见保存入口（ONLYOFFICE 本身）发起保存；平台使用后台保存回执/最终 callback 检查，不另叠加第二套“保存”用户按钮。
2. JWT/session/key/branch/participant 权限校验；下载 OOXML 过程不持 DB 长锁；校验大小/格式/哈希。
3. 事务锁 branch/session，确认 generation 和是否还允许保存，在 work_branch_revisions 追加一次确定 Blob/sha。
4. 交付前关闭当前轮次写入窗口，确保不存在尚可覆盖本轮 head 的未决 callback。创建 delivery + items 指向精确 revision/hash。
5. 失败、等待、重复或迟到回调不能标记“交付成功”；允许新轮次保存，但不能重写旧 delivery。

### TX-03 正式审批 → 创建已批准候选稿

1. 在正式审批前冻结 approval_subject Blob/sha/基准与已整合交付清单。
2. 审批事务锁实例/节点，按模板检查审批角色、先决节点、本人身份和回签权限；写独立 decision，不写受控生效 pointer。
3. 最后一道强制节点通过时，原子创建一个 approved_candidate，关联 subject/hash/approval_instance_id。不能自动发行。

### TX-04 准备 → 发行 → 派发

1. 冻结最终受控 artifact，核验审批源与转换/图章血缘、已确认编号版次、文控职能资格。
2. 创建 distribution plan 的 item/target/数量规范化摘要，经授权角色批准，产出 scope_approval digest。
3. 准备时预先分配 release_id 并建立 `state=preparing` 记录，冻结其 artifact 供 plan 引用；事务锁 plan/release，重新核对 plan digest、审批 source sha、发行物和权限；`issue` **仅转换原 release 的状态**并追加事件，不能再生成另一个 ID。`issue` 与 `dispatch` 分别提交，**不能共享“已发行即已派发”的状态**。
4. dispatch 在锁内核验 approved scope digest 与实际待发批次完全一致，冻结 batch/targets，生成接收待办及 outbox；不能签一个未批准的扩大部门清单。

### TX-05 签收 / 生效 / 回收

- 签收：锁 target/head → 验当前 validity/实际授权人/manifest_sha256 → 插入不可变 receipt + receipt_items → CAS 切换 head、ack_state → 审计/outbox → commit。
- 生效：锁 file effective pointer → 核验计划日期、发行资格、全部被配置的 hard gates、后继替代关系 → 原子切 pointer + 旧版状态投影 + activation_decision + outbox → commit。
- 回收：锁副本或 issue_lot → 核验实发/已收回与 actor 资格 → 逐份创建 withdrawal event → 重新计算统计；不能仅修改单一“已回收数量”。

## 6. API 合同修订与响应语义

### 6.1 统一协议

- 鉴权：Session/JWT + 对应资源和领域业务资格。普通技术 admin 不自动为正式文控审批人/签收人。
- 每个非幂等写操作发送 `Idempotency-Key` 请求头（首期唯一）：不在 JSON body 再重复存同名键。
- 可并发修改的资源使用 `If-Match: "rev-<n>"`；响应返回强 `ETag`，版本冲突返回 409 或 412（须全局约定一项）。推荐 409 `E_VERSION_CONFLICT` 保持既有后端错误习惯。
- 统一响应：`{ok:true,data:{...}}`、`{ok:false,error:{code:"E_CD_...",message?,details?}}`；未授权目标避免通过字段列表/错误消息泄露是否存在。
- 创建成功返回 201；异步 Office 保存请求返回 202 pending；真正持久化后回执报告持久化 revision；签收成功必须在 transaction commit 后才返回 200/201。
- 幂等表记录 `actor_id, operation, key, request_sha256, http_status, response, created_at`；同键异内容 = 409 `E_IDEMPOTENCY_REUSE`，同键同内容重放完全相同业务结果。数据库业务唯一约束仍须存在，不能只靠幂等表。
- 所有页列表拥有 `limit/cursor` 和严格服务器侧授权；结构化列表 `asOf, snapshotRevision, total?, nextCursor`；统计零分母为 null/not_applicable，禁止“100%”。

### 6.2 最少应补的示例 Schema

~~~json
{
  "POST /api/distribution-targets/:id/acknowledge": {
    "headers": {
      "Idempotency-Key": "uuid",
      "If-Match": "\"rev-3\""
    },
    "body": {
      "manifestSha256": "the-approved-and-frozen-digest",
      "statementVersion": "receipt-ack-v1"
    },
    "success": {
      "receiptId": "receipt_x",
      "actualReceiverId": "session-user",
      "acknowledgedAt": "2026-10-15T06:00:00Z",
      "manifestSha256": "the-approved-and-frozen-digest"
    }
  }
}
~~~

这是端点的设计示意，`manifestSha256` 示例值不是有效哈希，不可当作可执行请求。

## 7. 用户测试期前提下的简化方案

**从 V1.1 规格中移除的实施阻断**：
- `legacy_controlled_baselines`、`legacy_validated/unverified` 状态、旧审批凭证合法性重建；
- 历史 `released` → controlled release 的批量转换及历史分发签收补录；
- 旧版生命周期→新版发行的双写、影子读对账和长期运营兼容；
- CDW-35 迁移旧 `released` 的覆盖性要求（改成“新系统不产生伪历史数据”基础校验）。

**仍应保留**：
- 普通上传/预览/文件夹/ACL 的核心使用能力和当前数据模型必要接口；
- 从零构建完整 schema 的自动化可重复性与 schema checksum 机制；不可在已应用 migration 文件上随意修改，除非已明确销毁并重建隔离测试库。
- 未来新产生的正式审批、发行、签收、回收和审计事件不可被普通用户覆盖或伪造；
- 删除/回收站和 Blob GC 不允许破坏仍被活跃工作/发行证据引用的对象；这属于**新数据一致性**，不是历史迁移问题。
- 必需的授权、并发、回滚恢复、备份与远端 E2E。

### 7.1 数据库重建安全门禁（仅建议，不执行）

1. 确认目标确为**独立测试库**，没有正式/需保留数据；检查 DSN、PG database name、host、用户和环境标签。
2. 向用户明示“将删除该测试库的现有数据及相关 Blob”，获取**单独明确授权**后才可执行。
3. 需要保留的配置/测试账号/文件样本单独备份；记录重建前的迁移清单和代码 HEAD。
4. 在远端用正式 migrate CLI 对空 DB 由头至尾重放 SQL，校验 checksum，启动服务后执行 API/真实 Office/签收 E2E。
5. 不在本地构建/运行环境；遵守仓库 `AGENTS.md` 的远端规则。

## 8. 新增审查验收矩阵

| ID | 负面/并发场景 | 必需断言 |
|---|---|---|
| F-01 | 有效版切换两事务并发 | file PK pointer 唯一，后继关系正确 |
| F-02 | 模板增加两位审核人同时批准 | 每一 gate 仅一次有效决定，审批序列可回放 |
| F-03 | C 验收被高层替代而 B/A 未整合 | B/A obligations 不会自动完成 |
| F-04 | 同任务同时接受两种主要 assignment | 单一有效主责任约束命中 |
| F-05 | 两个根任务依赖并发形成环 | 全局依赖图仍无环；不能只锁各自 root 而遗漏跨根环 |
| F-06 | A、B 工作分支共享 file，但各自编辑 | 无 Blob/修订交叉，正式文件最新与有效版不受影响 |
| F-07 | 同分支多人使用 OnlyOffice 共同编辑 | 共享 doc key，参与者权限与操作能追溯 |
| F-08 | save 成功后另有未确认协作修改，立即提交 | 提交被阻止，直到写入封闭且最终持久结果明确 |
| F-09 | Callback 重放/迟到/退回重提 | 原交付 sha 不变，不重复追加修订 |
| F-10 | 实际派发目标/物件较批准清单多一项 | 拒绝 dispatch，需重新范围批准 |
| F-11 | target_item_requirements 跨 batch 引用 | DB 复合 FK 阻断 |
| F-12 | artifact_id 属于另一 release | DB 复合 FK 阻断 |
| F-13 | 同部门两人竞态确认一次签收 | 单有效 receipt，真实操作者明确 |
| F-14 | 正式签收后被授权撤销/更正 | 原 receipt 保留，仅 head 指针改变且事件完整 |
| F-15 | 印章升级后查看旧已发行 PDF | 固定 artifact sha 不变 |
| F-16 | Range/print 二次请求权限被撤回 | 即时拒绝，无未授权内容 |
| F-17 | 同幂等键不同请求体 | 409，零新事件 |
| F-18 | file 预览/下载/打印/搜索 | 受控版本解析一致，未生效候选不泄漏 |
| F-19 | 只有文件打开，没有本人点击阅读确认 | 阅读状态不算 confirmed；无培训率 |
| F-20 | 5 份纸质副本仅回收 4 份 | 剩一份 pending，不能伪造完结 |
| F-21 | 新版发布后旧版存在未完成部门待办 | 历史旧 ack 与 validity 正交，旧待办终止按策略记录 |
| F-22 | 空数据库重放所有 migration | 成功、所有新 FK/CHECK/UNIQUE 可验证，重复执行校验 checksum |
| F-23 | 事务中写事件后回滚 | 不应产生成功通知/伪完成状态 |
| F-24 | 文件没合法生效版 | 受控默认读明确拒绝，绝不隐式回退 latest |
| F-25 | 对 B 分支修订添加审查批注后 A 分支提交 | 批注仍锚定 B 分支原 revision/hash，不漂移到 A |
| F-26 | 受控 PDF 转换造成分页与文本重排 | 不能无证据把历史批注位置映射到新文件，无法定位时明确显示待重新锚定 |

## 9. 阶段建议与可开发条件

| 阶段 | 可交付内容 | 判定 |
|---|---|---|
| A：字段规格冻结 | 领域 ID 字典、表结构/关系、复合 FK、唯一索引、CAS、状态转移权限、错误 Schema | 所有 P0 关闭后可开发 |
| B：任务和 Office 分支 | task/assignment/gate/delivery；ONLYOFFICE 单保存入口的回调隔离 | F-03–F-09 |
| C：受控批准与发行 | approval subject/instance、不可变 artifact、单全局 effective pointer | F-01/F-02/F-15/F-18 |
| D：分发和签收 | scope plan/digest、batch items、target/receipt/reading/copy | F-10–F-14/F-19–F-21 |
| E：整合验收 | 从空测试库迁移、全链路 API、真实远端 Chrome、权限和备份恢复 | F-01–F-26 |

**建议修改 V1.1 与迁移合同**：将“历史数据迁移”为“干净测试环境重建/新数据一致性验收”；将 G0 生产制度最终认证从**开发前置门槛**改为**正式对外作为受控文件生产系统之前的门槛**。但受控分发流程如要求管理者代表确定部门与数量，原材料依据 [P] 仍须在系统中真实建模，不能以“测试阶段”为由删掉节点。

## 10. 结论

- **历史迁移：WAIVED（依用户最新测试阶段决定）**。
- **产品需求方向：PASS**。
- **字段级 DDL 冻结：NO-GO；P0-01～P0-11 需先关闭**。
- **允许按职责明确的独立阶段做设计/原型开发，但不应抢先启用正式受控发行**。
- **未作任何数据/业务代码/部署修改，不表示远端运行测试通过**。
