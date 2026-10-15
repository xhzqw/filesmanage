# CDW G1 — V1.2 受控协同内核决策、事务与 API 合同

> 状态：**设计合同已编写，未经过真实 PostgreSQL 执行/完整测试，不宣称工程冻结或 P0 实现关闭。**
>
> 前序：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md` 与 `docs/design/CDW-V1.1-FIELD-REVIEW-TEST-STAGE-2026-10-15.md`。
>
> 本文件及两份字段级 DDL 草案在冲突处优先于 V1.1 早期条款，**不改动用户确认的业务决策**。
>
> Schema 设计：`docs/design/CDW-G1-DDL-01-TASK-OFFICE.sql` → `docs/design/CDW-G1-DDL-02-RELEASE-DISTRIBUTION.sql`。这两份是仅限设计目录的 PostgreSQL 17 草案，不是 migration，不得直接执行。
>
> 前提：filesmanage 测试阶段，旧测试数据无须迁移和补录。**未授权清库**；如将来需要清除测试库，另行明确确认目标数据库和 Blob 范围。

## 1. 锁定的架构裁决

| ID | 裁决 | 依据 |
|---|---|---|
| ADR-CDW-01 | 任务与责任的权威是 `cdw_tasks + cdw_task_assignments + cdw_accountability_obligations`；`tasks.current_assignee` 不再单独存为权威 | P1-01；多级派发不转移上级责任 |
| ADR-CDW-02 | 每份文件 V1 唯一全局 `cdw_effective_pointers(file_id)`；不同厂区/部门分别生效是 V2 扩展 | P0-02，消除 scope 重叠 |
| ADR-CDW-03 | Office 保存仅写 `cdw_work_branch_revisions`，不更新 `files.current_version_seq`；同分支一个活动 doc key，多个获授权成员共享 | P0-03/04 |
| ADR-CDW-04 | 冻结待审 `approval_subject` → 审批实例 + 节点决定 → 最终 `approved_candidate`；候选审批不生成当前生效版 | P0-01 |
| ADR-CDW-05 | 准备发行即创建 `controlled_release(id, state=preparing)`，冻结 artifact；批准分发计划引用稳定 ID；`issue` 不再生第二个 ID | P0-05/11 |
| ADR-CDW-06 | 分发范围批准只能批准**冻结内容的规范摘要**，不是批准一个可继续修改的数组；派发时重算摘要 | P0-05/10 |
| ADR-CDW-07 | 仅 `cdw_target_receipt_heads.current_receipt_id` 标识当前有效部门签收；凭证内容永不 UPDATE | P0-07 |
| ADR-CDW-08 | 受控普通内容查询仅 `ResolveContent` 提供确定 artifact ID + SHA，二次数据流请求重验权限 | P0-08 |
| ADR-CDW-09 | 控制领域仅新命令拥有正式业务写权；旧 approve/publish/Office callback **对 managed 文件不得改变受控权威**；普通非受控文件仍可用文件管理基础能力 | P0-09 |
| ADR-CDW-10 | V1 默认每部门一次授权负责人签收，允许有据可查的代理；多人会签在未来版本拆分为多个强制签收义务 | P0-07、用户部门+阅读确认决策 |
| ADR-CDW-11 | 编辑器保留唯一用户可见的 ONLYOFFICE 保存入口；平台自动查回执并执行“冻结提交”，不引入第二套保存按钮 | 现有 Office 交互治理 |
| ADR-CDW-12 | 制度中的分发范围确定角色及发放数量单独记录；培训不在本期，无培训率或默认培训生效条件 | PDF 梳理材料与用户确认 |

## 2. ID、事实对象和状态来源

| 对象 | 唯一权威 | 不变条件 |
|---|---|---|
| 任务 / 有效责任分配 | cdw_tasks / cdw_task_assignments | 同任务最多一项 live primary |
| 任务资料包范围 | cdw_task_manifest_versions + items | 清单冻结后不可覆盖，文件移动不改变 |
| 工作分支 | cdw_work_branches | branch/file/task 对应关系不换底稿 |
| Office 编辑快照 | cdw_work_branch_revisions | branch,revision,Blob,hash 追加式 |
| 交付 | cdw_deliveries + delivery_items | 单文件也是一个 item；提交物不可覆盖 |
| 逐级验收 | cdw_review_gates + immutable decisions | 每 gate 最终决定最多一个，上级义务另计 |
| 待审稿 / 审批 | cdw_approval_subjects / formal_approval_instances | 审批绑定精确 Blob/sha，不依赖 latest |
| 已批准结果 | cdw_approved_candidates | 只能从全部必需节点合格的实例创建 |
| 受控发行物 | cdw_controlled_releases / release_artifacts | 准备阶段即固定 release_id；artifact Blob 永不换 |
| 分发范围与批次 | cdw_distribution_plans / scope_approvals / batches | 审批和实际发送用同一个 digest |
| 部门签收 | department_receipts + target_receipt_heads | 真实 signer/time/manifest sha，只有 head 的 receipt 有效 |
| 人员阅读 | reading_rosters/assignments/events | 阅读确认不得由查看自动触发 |
| 当前有效受控文件 | cdw_effective_pointers | 一文件一全局发行；发行 state 为受控投影 |
| 审计 | cdw_domain_events + audit_events + outbox_jobs | 与业务事务原子写入，通知非权威 |

**约定**：SQL 设计表使用前缀 `cdw_`，服务端 DTO 不必暴露此前缀。既有 `files.current_version_seq` 只作普通文件内部历史/兼容读取，**不是受控业务的生效指针**。

### 2.1 权限与身份

- 有效权限 = 文件 ACL / 发行授权 + 受控业务角色 + 任务/部门范围 + 当前帐号有效性 + 时间/撤销检查。纯技术管理员不代替文控/正式审批人/部门签收人。
- `cdw_workgroup_role_bindings` 提供负责人/副手有效任职；组织内“工作组成员”本身没有“工作组负责人接收任务”权限。
- `cdw_business_role_bindings` 提供正式审批、文控签发、分发范围确认、部门接收、代理、人工生效与回收职责；授权人和任职快照进入关键审批/签收证据。
- 文件夹范围固定清单不增加文件访问资格；跨部门阅读通过特定 `release_artifact` 级别的最小授权实现。
- 浏览器/客户端不可指定有效 actor_id、receipt actualReceiverId 或审批人身份。

## 3. 五条核心事务协议（可供 Go Application Command 实施）

### TX-01 — 派发 / 子任务 / 越级验收

1. 通过 `Idempotency-Key` 先锁或插入 `cdw_operation_results`，并验证请求摘要。相同请求已完成只回放已提交结果，同键不同内容返回 409。
2. 对任务 root + 当前 assignment + gate 采用稳定顺序 `SELECT ... FOR UPDATE`；新增跨根 `task_dependencies` 之前使用单一事务级 Advisory Lock，阻止两个事务同时写入互相依赖构成环。
3. 新子任务从上级冻结 manifest 中选择合法子集或以明确范围修订；验证接收人或当前工作组有效负责人任职。创建 child task 和新 primary assignment，但**不结束父任务的管理/整合义务**。
4. 越级验收只可根据有效 `cdw_override_grants` 替代可替代的 ReviewGate。记录真实 actor / acting_for / authority grant，绝不冒充 B 原签名；父级 accountability obligations 原样待履行。
5. 提交事件/审计/outbox/幂等结果同事务。事务外推送通知，失败可以持久恢复。

### TX-02 — ONLYOFFICE 保存确认 / 冻结交付

1. `branch_id` 是文件隔离单元；`session.document_key` 在同一协作分支的所有授权编辑参与者间一致，非协作同一分支只允许一名写者。
2. ONLYOFFICE 保存入口触发状态变化，平台创建 `cdw_office_save_requests` 并等待服务端持久回执；force-save 命令 OK **不**等于保存已持久。
3. callback JWT/key/session/generation/userdata 严格对应；下载前做最小探测，不跨网络请求持有 PostgreSQL 行锁；下载完成校验 OOXML 内容、大小、SHA。
4. 事务锁 branch + session，验证 `edit_epoch`、参与者权限和状态仍有效，对未见过的 callback/hash 只追加一次 `cdw_work_branch_revisions`，回执标记 persisted，保存事件与 outbox 同事务。
5. 提交交付先将分支 `open→fencing`，停止当前轮次新的写入口；等待最终关闭/保存屏障，检查该轮次无未决会影响最终 head 的 callback；然后冻结精确 `branch_revision_id + blob_id + sha256`，写 delivery 和 items。
6. 执行人与审核人看到“可以提交”必须以**后端最终持久回执**为准；未知/超时进入待确认，而非显示成功。后续修改开启新 round/epoch；旧交付不可变。

**风险补充**：WebSocket 离线、浏览器断开或 ONLYOFFICE 延迟 callback 期间不能把“最后一次已持久保存”冒充“编辑窗口已清空未保存修改”。必须有同轮次 fencing/close 合同和稳定的最终回调检查。

### TX-03 — 正式审批决定 / 冻结批准结果

1. 将已整合稿的最终文件 Blob、sha 和来源 delivery IDs 写入 `cdw_approval_subjects`，严禁使用可编辑的 branch head 作审批对象。
2. 创建 `cdw_formal_approval_instances` 并快照模板版本、每节点审批人/资格；依流程图状态开启 gate。
3. 审批事务锁 instance + step，校验 actor 业务资格、前置节点、申请文件哈希、CAS、单节点 UNIQUE，追加唯一 `cdw_formal_approval_decisions`。
4. 最后必需节点完成时，原子新增 `cdw_approved_candidates`，并将 instance 标记 approved；不追加 current_version_seq，不创建 release，也不对用户开放新执行版。
5. 退回修订产生新的 approval_subject/instance，不可篡改旧决定。

### TX-04 — 冻结分发计划 / 确认范围 / 正式发行 / 派发

1. 以已批准候选冻结 release 记录（`state=preparing`、稳定 `release_id`）和实际分发 artifact(s)，包含 converter / seal revision / artifact SHA 血缘；禁止未来替换相同 artifact ID 的 Blob。
2. 根据一个或多个准备中 release 构成 distribution_plan：按序排列发行物清单、目标部门、指定接收人、电子/纸质方式、数量、可选阅读要求。单文件就是单 item 的 plan。
3. 在事务中冻结 plan，按下面 `canonicalDigest` 规则计算 digest 并写入 plan；`scope_approver` 主动确认该摘要与目标范围，产生不可变 scope_approval。
4. `issue` 只将**已经存在的对应 release**从 preparing/ready 变为 issued_pending；事务内重新校验批准内容/sha、受控版次、章与编号、批准 plan.digest；不得另建 release ID。
5. `dispatch` 锁 plan/release/batch，核对 scope_approval.plan_digest == plan.digest == batch.digest，核对冻结 items/targets/**每目标文件签收及阅读要求**与已批准清单完全相同，才发送。新增 batch items / targets / receipt_heads / 阅读分配及 outbox，事务提交后才通知。数据库通过 plan_target_requirements → target_item_requirements 的复合外键强制关联，应用仍须在冻结事务内检查目标范围完整性。
6. 撤回、修订、增补目标部门、换接收文件或变更分发数量必须新建/再批准 plan，不得改原 digest 后继续使用旧批准。

### TX-05 — 部门签收 / 人员阅读 / 生效 / 回收

**签收**：锁目标和 receipt head → 验目标有效、actor 的部门职责/代理与版次、manifest digest、幂等键 → 插入不可变 receipt + receipt_items → CAS head 指针 → 写证据和私有通知 → commit。`ack_state` 从 head 是否有有效凭证**派生**，不维护第二个自由可写状态。

**人员阅读**：按目标批次每 item 冻结阅读名单快照；打开记录 `opened`，只有本人主动确认记录 `confirmed`；与部门签收独立。

**生效**：到时调度只触发检查，事务锁 `cdw_effective_pointers(file_id)`；依策略检查已批准/发行、当前适用计划、必要的部门签收、人工生效、可选阅读确认、撤回/争议，原子更新 pointer + 发行 state 投影 + `cdw_activation_attempts` + outbox。不得自动回退旧有效版。当前没有合法版时明确 `no_effective_release`。

**旧版回收**：纸质批次一份一号，冻结 lot 时校验 issued_qty 和实际 copies 数；收回每份单独记录事件；5 发 4 收显示未完成 1 份。电子旧版受控默认入口退出，无法远程销毁已下载副本。

## 4. 规范化摘要 / 内容绑定 / 版本读取

### 4.1 canonicalDigest v1

- 使用 JCS（RFC 8785 的 JSON Canonicalization Scheme）生成规范化 UTF-8 字节；SHA-256 结果以 64 位小写十六进制记录。
- 摘要输入对象显式包含 `schema:"cdw-distribution-plan-v1"`、`planId`、`items`（按 ordinal 升序，包含 ordinal、releaseId、artifactId、artifactSha256、required）、`targets`（按 departmentId 二进制升序，包含 departmentId、designatedReceiverId、channel、paperQuantity、itemRequirements）。每个 `itemRequirements` 以 itemOrdinal 升序编码 `itemOrdinal、receiptRequired、readingRequired、implementationRequired`；这是冻结的**批准范围**的一部分，而非派发时临时选择的选项。
- JCS 对对象字段名按 UTF-16 代码单元升序编码。V1 输入只包含字符串、布尔值和非负整数；编码前必须拒绝重复部门、重复序号、悬空文件引用、非法 channel/数量、不合法 artifact SHA，以及缺少文件要求的目标部门。
- 不包括 `state`、时间戳、客户端 displayName、任意对象 map 顺序或数据库事务序号。时间等业务信息若影响正式批准范围，必须明确列入相应版本 schema 后再冻结。
- 服务端与浏览器可展示 digest 前 8 位辅助人工对照，但客户端提交 hash 不作为权威；服务端总是重算。版次/成员变化导致摘要变化，原 scope approval 失效。
- 新的字段版本不能在旧 schema 名称下改变编码，必须升级 schema tag 并生成新的确认。

### 4.2 ResolveContent

`ResolveContent(fileId,purpose,actor,context) → artifact/version Blob id、sha、access epoch` 由服务器执行。受控 `normal-preview / download / print / search` 只能选择全局 effective_pointer 指向的 release；分发签收指向**该 target 的 batch item 的 artifact**；工作分支和正式审批须带相应 branch/subject 授权上下文。

- 由服务端生成短期受限下载/打印引用，二次 GET/Range 按当前用户资格与 auth_epoch 重新验证，不再选择任何“最新”来源。
- 工作分支不能被普通全局搜索索引暴露；受控尚未生效的 approved_candidate 默认不能被执行入口读取。
- 系统中 `current_version_seq` 与全局受控 `effective_pointer` 是不同业务值，不能自动互相同步当作替代。

## 5. API 统一约定（G1 决定）

### 5.1 请求和响应

- HTTP `Idempotency-Key` **请求头**（长度和字符集由 OpenAPI 限定，建议 UUID），用于所有副作用命令；JSON body 不再重复 `idempotencyKey`。
- 条件写使用 `If-Match: "rev-N"` 强 ETag；服务端成功返回 `ETag` 和 body revision。不允许同时在 body 传不同 expectedRevision。
- 身份完全来自 Session/JWT；请求不得自报 actor/actualReceiverId。
- 成功为既有风格 `{ok:true,data:{...}}`；失败 `{ok:false,error:{code:"E_CD_...",message?,details?}}`。按既有后端习惯，状态/修订冲突统一 409 `E_VERSION_CONFLICT`。
- 创建 201；异步保存请求 202（`pending`）；正式签收提交完成才返回 200/201；阻断 422，未授权 403/404；未知保存不可报告成功。
- 幂等键同一 (actor,operation,key) + 同样 request SHA 必须返回**最初提交的状态码及结果**；同键不同内容 409 `E_IDEMPOTENCY_REUSE`；独立业务唯一索引仍约束新键重放。

### 5.2 最小操作矩阵

| 动作 | 方法与路由 | 核心入参 | 成功要点 |
|---|---|---|---|
| 派发 | POST /api/workbench/tasks/:id/delegate | assignee、manifestVersionId；头幂等/CAS | childTaskId、parentObligations |
| 工作组接收 | POST /api/workbench/tasks/:id/accept | 头幂等/CAS | actualAcceptorId、acceptedAt |
| 同分支开启协作 | POST /api/work-branches/:id/collaboration | participantIds、enabled；CAS | editorMode、revision |
| 查保存状态 | GET /api/work-branches/:id/save-requests/:rid | 无请求体 | pending / persisted / failed / unknown |
| 交付冻结 | POST /api/work-branches/:id/freeze-delivery | branchRevisionId、taskId、roundNo；CAS | deliveryId + digest |
| 验收 | POST /api/workbench/review-gates/:id/decide | decision、reason、overrideGrantId?；CAS | decisionId + remainingObligations |
| 申请正式审批 | POST /api/formal-approvals | approvalSubjectId、templateVersionId；幂等 | instanceId |
| 审批节点决定 | POST /api/formal-approvals/:id/steps/:stepId/decide | decision、reason；CAS | step state、批准结果候选 ID? |
| 发行准备 | POST /api/controlled-releases | approvedCandidateId、revisionLabel；幂等 | **preparing releaseId** |
| 冻结分发计划 | POST /api/distribution-plans/:id/freeze | 头幂等/CAS | planDigest、revision |
| 范围确认 | POST /api/distribution-plans/:id/approve-scope | planDigest；幂等 | scopeApprovalId、approverId/time |
| 正式发行 | POST /api/controlled-releases/:id/issue | 头幂等/CAS | 原 releaseId、issuedAt |
| 正式派发 | POST /api/distribution-plans/:id/dispatch | 头幂等/CAS | batchId、targets、manifestSha256 |
| 部门签收 | POST /api/distribution-targets/:id/acknowledge | manifestSha256、statementVersion；头幂等/CAS | receiptId、actualReceiverId、signedAt |
| 阅读确认 | POST /api/reading-assignments/:id/confirm | statementVersion、artifactSha256；幂等 | actualReaderId、confirmedAt |
| 生效 | POST /api/controlled-releases/:id/activate | 头幂等/CAS | state 或 blockers |
| 回收 | POST /api/controlled-copies/:id/collect | reason；头幂等/CAS | collectedAt、actualCollectorId |

**接口示例：部门签收**

~~~http
POST /api/distribution-targets/target_01/acknowledge
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
If-Match: "rev-7"
Content-Type: application/json

{"manifestSha256":"<server-frozen-64-hex>","statementVersion":"receipt-ack-v1"}
~~~

~~~json
{
  "ok": true,
  "data": {
    "receiptId": "receipt_x",
    "actualReceiverId": "authenticated_user",
    "signedAt": "2026-10-15T06:00:00Z",
    "manifestSha256": "server-verified-digest",
    "revision": 8
  }
}
~~~

以上示例使用文本占位符，不可作为真实请求哈希。

### 5.3 错误码（草案）

| HTTP | code | 含义 |
|---|---|---|
| 409 | E_VERSION_CONFLICT | If-Match/CAS 已过期 |
| 409 | E_IDEMPOTENCY_REUSE | 同键不同内容 |
| 409 | E_CD_OFFICE_SAVE_PENDING | 尚未完成最终保存屏障 |
| 409 | E_CD_DISTRIBUTION_DIGEST | 实际派发与已批准内容不同 |
| 403 | E_CD_ROLE_REQUIRED | 缺失有效业务角色 |
| 403 | E_CD_OVERRIDE_NOT_AUTHORIZED | 越级授权过期、动作不允许或范围不符 |
| 422 | E_CD_ACTIVATION_BLOCKED | 生效守卫缺少必要条件（返回 blockers） |
| 422 | E_CD_NO_EFFECTIVE_RELEASE | 当前无合法可执行受控版本 |
| 422 | E_CD_CONTENT_HASH_MISMATCH | 内容/清单哈希不匹配 |

## 6. G1 设计关闭清单

| 原审查 P0 | 本轮交付的设计位置 | 状态 |
|---|---|---|
| P0-01 审批先后 | DDL02 approval_subject/instance/steps/decisions/candidate、TX-03 | 设计草案覆盖 |
| P0-02 scope 重叠 | DDL02 effective_pointer(file_id PK) | 设计草案覆盖 |
| P0-03 协作成员 | DDL01 office_branch_participants | 设计草案覆盖 |
| P0-04 保存屏障 | DDL01 save_requests/delivery_freezes、TX-02 | 设计草案覆盖；需真实 ONLYOFFICE 验证 |
| P0-05 分发摘要 | DDL02 plan/items/targets/scope_approval、TX-04 | 设计草案覆盖 |
| P0-06 跨批次 FK | DDL02 target/item/receipt 复合 FK | 设计草案覆盖；待 PG 测试 |
| P0-07 签收有效指针 | DDL02 receipt_heads+复合 FK、TX-05 | 设计草案覆盖 |
| P0-08 读版本策略 | ResolveContent 合同、TX-05、访问授权 | 设计草案覆盖；尚未重构现有 Go 入口 |
| P0-09 双权威 | ADR-CDW-09 与命令切流 | 设计草案覆盖；代码未实现 |
| P0-10 受控角色和范围 | DDL02 business_role_bindings/scope_approvals | 设计草案覆盖 |
| P0-11 稳定发行 ID | DDL02 release 先创建、TX-04 | 设计草案覆盖 |

**本轮不足以宣布 P0 已经在运行系统关闭。** 后续先在隔离远端空 PostgreSQL 17 数据库执行 SQL 语法与约束负面测试，并对 DDL 的触发器/事务做并发验证；再移入正式 migration，改 Go 业务写命令、迁移读路径，最后搭建 React 工作台。

## 7. 验收硬条件

- 不能跨 release 引用另一个 artifact/sha；不能跨 batch 引用 target/item。
- 审批通过但未生效：所有默认预览/下载/打印/搜索仍用合法当前受控版。
- ONLYOFFICE B/C 分支保存互不覆盖、不能推进正式文件；同分支明确开启协作才共享 doc key。
- 授权越级只替代指定 gate，不自动清除 A/B 管理与整合责任。
- 分发摘要发生任意部门/副本数量/发行物变化，旧批准不可用。
- 同一部门两个有效签收尝试只能留下一个 head；更正保留旧事实。
- 未完成阅读确认不得视为“已读完成”，更不能视为培训；本期不产出培训率。
- 无合法生效受控版本时返回明确状态，不回退 latest。
- 新建受控业务的证据不可用“删除普通文件”级联清理。
- 数据库清空/重建属于独立破坏性授权，不是本设计交付的一部分。
