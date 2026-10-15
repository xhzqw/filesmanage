# CDW-RELEASE-DISTRIBUTION-CONTRACT-v1.1 — 受控发行、生效、部门签收与旧版回收

> 隶属：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md`。本文件为拟议工程合同。
> 上位材料：PDF 第 3 页 A2.1/A2.2、第 4–5 页 A3，具体制度签章资格、分发数量、生效条件需与文控部门核对。
> G1 优先规则：`CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md`、`CDW-G1-DDL-02-RELEASE-DISTRIBUTION.sql` 固定一文件全局生效指针、准备时生成稳定 release_id、签收 head 为唯一权威、统一幂等/CAS 请求头。以下早期示例中的 `(file_id,scope_id)`、`release_id 后建` 及 body idempotencyKey 等被 G1 取代。

## 1. 工作边界与流程：批准≠发行≠生效≠签收

1. `approved_candidate` 只证明确定候选稿通过对应正式审查；审批人真实身份和批准源 Blob/哈希不可变。
2. `release_preparation` 由文控核验：文件编号、A/1 等受控版次、已批准源版本、正式转换与盖章产物、签发角色、旧版替代关系。
3. `distribution_scope_approval`：确定目标部门及发放数量/方式，记录确定人及权限。上传的流程梳理 A2.1 写的是管理者代表；实际电子文件和数量权限以受控原件 [V] 为准，**未经确认不能由文控随意扩大目标清单**。
4. 文控发行产生 `controlled_release`：不可变发行产物及策略快照；可分发到指定部门。
5. 受控分发生成 `batch`、`batch_items`、`targets`、接收待办。对部门签收是一套独立状态；相关人员按策略创建阅读待办。
6. 实际生效以确定范围中的唯一 `effective_pointer` 事务切换为准。旧版历史保留，电子旧版退出常规执行入口，纸质旧版副本单独回收。
7. 发放、复制、借阅、查阅、补发、外来文件的现有程序不得被新工作台的通用分享/下载/打印规避；V1.1 的实现覆盖范围另在迁移合同标明。

## 2. 正式批准→发行的不可绕过门禁（P0-A/P0-D）

- 准备发行只能引用 `approved_candidate_id + formal_approval_id + immutable file_version_id + content_sha256`；使用源文件当前 Seq 或文件修改权限**不足以取得发行资格**。
- 正式审批节点的人员资格依模板快照/审批角色而定；`actor.IsAdmin` 不是可代替质量手册/技术文件签批的依据。
- 多分支可并行执行/验收，多候选可进入整合准备，但**同一文件/适用范围/基准世代的正式候选准入必须有明确且可串行化的决策**；不绕过旧 `uq_pending_approval`，通过独立新模型逐步迁移。
- 文控必须核验全部必需批准、审批所针对的内容哈希、签章是否需要及内容血缘、分发范围审批、编号/版次唯一性。
- 所有守卫在同一个发行事务中重验；不可用的审批证据、Blob、签章资产、禁用用户、范围授权都不允许通过前端 UI 判断后直接发行。
- 旧 `PUT /api/files/:id/lifecycle {action:"publish"}`：对于已纳入受控域的文件，禁止由该遗留 API 写入正式发行状态；必须转到统一发行命令或返回明确 `CONTROLLED_RELEASE_REQUIRED`。普通非受控文件旧行为暂保留，不造假历史。

## 3. 不可变发行物及签章/转换血缘（P0-E）

| 表 | 核心字段 | 约束 |
|---|---|---|
| approved_candidates | id、file_id、integration_candidate_id 可空、version_id、sha256、approved_at、approval_id、template_version_id | 来源不可变、批准内容唯一 |
| release_preparations | id、candidate_id、controlled_code、revision_label、planned_effective_at、policy_version_id、state、revision | 后续核验事务；不能改动源审批 |
| distribution_scope_approvals | id、preparation_id、manifest_hash、determined_by、authority_basis_id、determined_at、scope_json | 目标/副本数量审批凭证 |
| controlled_releases | id、file_id、source_candidate_id、version_id、controlled_code、controlled_revision、display_name_snapshot、scope_id、planned_effective_at、actual_effective_at、supersedes_release_id、state、revision | 唯一合法发行、状态机审计 |
| release_artifacts | id、release_id、kind、source_blob_id、conversion_job_id、seal_revision_id、blob_id、sha256、size_bytes、is_primary、created_at | 已发行 Blob 永不覆盖，主发行产物唯一 |
| release_events | id、release_id、actor_id、kind、at_utc、request_id、before/after、reason、evidence_hash | 追加式，变更需补偿事件 |
| effective_pointers | file_id、scope_id、release_id 可空、state(active/none)、revision、activated_at | PRIMARY KEY(file_id,scope_id)，版本切换锁 |
| activation_attempts | id、release_id、scope_id、planned_at、attempted_at、outcome、blockers_snapshot、trigger_kind、idempotency_key | 调度恢复和审计 |

### 3.1 发行物血缘

批准源稿 X（`approval_id, version_id, source_sha256`） → 经确认转换 PDF Y（`conversion_job_id, converter_version, output_sha256`） → 必需签章修订 Z（`seal_revision_id, marks_digest`） → 最终冻结发行 Blob Q（`artifact_id, sha256, size_bytes`） → 部门签收时展示的恰为 Q。

**禁止**：部门阅读时动态以 `currentSeq(file)` 或“最新图章修订”生成新的 Q；如果发行后的章样式/页数/文案需要修改，创建发行物修订或新发行并重走必要授权流程，不能覆盖原 Q。电子发行物的签章法律/制度等效 [V]，不是 PNG 能绘制就自动符合公司制度。

### 3.2 受控标识/数量的制度合同

PDF A2.1 记载文控对原件/副本加盖“原件章”“受控文件章”，管理者代表规定分发部门和数量 [P]；本系统必须可追踪章标识、发放方式 `electronic | paper | mixed`、预定/实发数量与原件/副本标识。纸质逐页盖章仍按实际制度处理。电子是否需视觉水印/章、是否可代替纸质签名/数量如何计数都应由文控 [V] 确认，不得在无规则时自动设“电子数量=1份”。

## 4. 单文件与资料包统一分发模型（P0-F）

| 表 | 字段 | 约束 |
|---|---|---|
| distribution_batches | id、policy_snapshot_id、scope_approval_id、manifest_sha256、sender_id、dispatched_at、validity_state、revision | 批次**必须包含 ≥1 冻结 item** |
| distribution_batch_items | id、batch_id、ordinal、release_id、artifact_id、artifact_sha256、is_required | UNIQUE(batch_id,ordinal)；每 item 必须确实属于其 release |
| distribution_targets | id、batch_id、department_id、department_name_snapshot、receiver_id、ack_state、validity_state、revision、due_at | UNIQUE(batch_id,department_id)；变更部门范围不覆盖原 |
| target_item_requirements | target_id、batch_item_id、receipt_required、reading_required、implementation_required | 对每部门/文件决定是否逐项签收和阅读 |
| department_receipts | id、target_id、actor_id、authorized_role_id、receiver_snapshot、manifest_sha256、statement_snapshot、signed_at_utc、evidence_hash | 原始凭证严格只追加、不可更新 |
| department_receipt_items | receipt_id、batch_item_id、artifact_sha256 | 签收的是确定的实际 item |
| distribution_target_events | id、target_id、actor_id、kind、occurred_at、reason、payload_hash | 追加式历史 |
| distribution_delivery_events | id、target_id、recipient_id、channel、status、attempted_at、delivered_at、error_code | 通知送达≠正式签收 |
| target_receipt_heads | target_id、current_receipt_id 可空、revision、updated_at | PK(target_id)，更正/撤销事务切换当前有效凭证指针，旧 receipt 本身不改 |

**关键约束**：签收服务端在事务中用 batch_items 规范化排序并计算 canonical manifest digest；哈希包括 schema version、batch_id、排序后的 item IDs/发行物 hash、签收范围及关键业务标识，明确 UTF-8、字段顺序与编码方式，禁止依赖不稳定的 JSON map 遍历顺序。签收事件同时保存签收声明与实际向用户展示的内容集合。

### 4.1 资料包成员被撤回

- 已发出的 batch manifest 和已签收证据不能修改。
- 任意必需 item 被撤回，系统按分发策略将相关未完成任务标为 `action_required/revoked_scope`，重新派发新批次或发出撤回通知。
- 已完成旧批次签收仍是历史事实，但不算新批次完成。
- 若仅某一非关键 item 失效，可走经文控批准的补充/更正批次，原 batch 不回写。

### 4.2 多部门、多接收人和工作组

目标是**部门**，可指定一个主要接收人、多个按权限配置的候补/代理接收人；签收应按策略明确“一名有权人代表部门生效”或需要多人会签。默认建议一名主要授权人员确认、合法代理可替代；多人会签必须建多个 `receipt_obligations`，不能靠重复一张 receipt。工作组成员由其负责人决定使用人员阅读名单，不能因此获得正式文控签发资格。

## 5. 签收与个人阅读正交状态

### 5.1 分发目标

分离：
- `ack_state = pending | acknowledged | declined | exception`；
- `validity_state = active | superseded | withdrawn`；
- `notification_state = queued | delivered | failed`（来自独立投递表，不算签收）。

A/2 已签收后被 A/3 替代，仍然 `ack_state=acknowledged, validity_state=superseded`；历史统计按时间点能查到这项真实签收。拒收后重新指派应保留拒收事件和原指定人，不将历史拒收事件改写。

### 5.2 部门签收凭证

只有具有效部门签收资格（含经过明确授权代理）、当前有效分发目标且阅读过**指定受控内容清单**的登录操作者才能执行主动签收。签收记录：
`target_id, actor_id, designated_receiver_snapshot, authority_basis_id, manifest_sha256, artifact_hashes, acknowledgement_text_snapshot, signed_at_utc, request_id, auth_session_reference, client_ip_context`。
- 后端校验身份、目标、版次、代理资格与幂等键；客户端不允许指定他人为 `actor_id`。
- 首次打开与通知送达单独记录，不能自动确认。
- 错误签收必须产生 `receipt_voided/corrected` 追加事件并要求重新签收；原凭证保留。事务内锁定 `target_receipt_heads(target_id)` 并通过 CAS 清空/更新当前 receipt 指针，不能 UPDATE/DELETE 原 department_receipts。只有有效指针指向的凭证算当前签收，历史事实按事件时点统计。
- 保存原事件及签收时权限/组织角色快照；人员离职/调岗不抹除旧事实。

### 5.3 个人阅读

表：`reading_rosters(id,target_id,revision,freeze_sha256,created_at)`、`reading_assignments(id,target_id,batch_item_id,user_id,roster_revision,state,required,attributed_role_snapshot)`、`reading_events(id,assignment_id,kind,actor_id,at_utc,artifact_sha256,statement_snapshot)`。

状态：`assigned / opened / confirmed / exception / cancelled`。`opened` 仅说明访问过特定受控发行物；`confirmed` 必须本人主动确认。名单后续变化通过 `roster_revisions` 追加事件；不修改原人数快照。**没有培训相关表、培训进度或培训率。**

### 5.4 统计指标

| 指标 | 口径 | 特殊情况 |
|---|---|---|
| 部门签收率 | 有效分发目标中已有效签收 / 该快照要求签收的有效目标 | 例外、拒收、已撤回单列；分母为 0 显示不适用 |
| 人员阅读率 | 当前适用且必须阅读的 assignments 中已确认 / 该口径要求 assignments | 历史用 `as_of` 和 roster_revision 回放 |
| 旧版回收完成率 | 应回收的有效副本/目标中完成要求 / 实际应回收总数 | 数量统计与目标完成率不得混算 |

接口必须同时返回 `asOf, snapshotRevision, required, completed, exempted, cancelled, overdue, denominator`，禁止后台默默调整历史统计或显示无定义的“100%”。

## 6. 生效、旧版退出与调度补偿

### 6.1 发行状态机

`preparing → ready → released_pending_effective → effective → superseded`；准备阶段可 `cancelled`；待生效/有效阶段可经授权 `withdrawn`。条件未满足时留在 `released_pending_effective`，记录 blocker，不写 `actual_effective_at`。

### 6.2 生效条件

`approved && issued && time_reached && required_scope_ack_satisfied && required_reading_satisfied_if_configured && required_withdrawal_satisfied_if_configured && scope_consistent && !blocking_disputes`。

支持：
- `scheduled` 默认普通受控文件；
- `key_department_ack` 按经批准策略定义；
- `manual_activation` 指定有权人明确确认；
- `required_reading` 可选，默认关闭；
- **不支持 `training_gate`。**

### 6.3 调度器/事务

- 工作队列按计划时间扫描待生效发行；定期补扫防消息丢失；重启后不漏掉过期候选。
- 获取对应 `file_id,scope_id` 的数据库事务锁；再次计算所有 gates；比较 pointer revision 与候选替代关系，严格检查是否存在更新的合法生效候选。
- 符合条件时事务内同时写 `activation_decision`、更新唯一 `effective_pointer`、把被替代 release 标为 superseded、追加审计/outbox；提交成功后广播无资源敏感信息的失效通知。
- 失败/争议写 blocker + 错误分类并设置重试，不伪造 actual_effective_at；一个 release 不得在并发调度中重复生效。
- 紧急撤回若无合法替代依据，pointer 进入 `no_effective_release` 业务状态，不自动回退未经授权旧版；必须通知所有受影响对象并启动撤回任务。

### 6.4 旧版电子撤回及纸质副本

- 电子版受控执行入口换新，旧版本可在“历史”按专门权限访问并显示失效警告；既有下载无法被远程删除。
- **纸质副本按物理单份编号**：`controlled_copy_issue_lots(id,release_id,department_id,issued_qty,issued_at)` 记录一次发放数量；`controlled_copies(id,issue_lot_id,release_id,copy_no,holder_id)` 中每行代表一份，`UNIQUE(release_id,copy_no)`；`withdrawal_events(id,copy_id,event_kind,actor_id,occurred_at,reason)` 逐份追加回收/丢失/销毁事件。必须校验 lot 的 `issued_qty` 等于其创建时冻结的 copy 数，不能在回收时靠修改计数冒充实际回收。
- 发放 5 份、回收 4 份必须展示 1 份待回收；遗失、损坏、销毁、授权豁免均独立状态及证据。
- [P/V] PDF 的作废原件留存和销毁登记规则应映射独立保留策略，确切适用类别/年限应按现行受控原件核对；GC 不得抹去仍需保留的发行/签收/回收/审计物证。
- 复制、借阅、查阅、补发与外来文件作为相关域追加待办计划，直到正式替代前遵从旧受控制度，不能绕过授权。

## 7. 发行级最小权限

`controlled_release_access_grants(id,release_id,artifact_id 可空,subject_kind,subject_id,actions,expires_at,revoked_at,source_target_id)`：
- 分发可授予特定受控发行物的 preview；是否允许受控打印/下载依文件制度，不自动继承源文件夹修改/删除/历史查看权。
- 接收人切换、分发撤回、禁用账号或员工离职应立即阻止新的阅读/下载请求（短期 token 校验授权纪元）；下载的先前副本无法远程追回。
- 文控拥有发行职能并不自动拥有部门代签资格。管理员维护系统不等于具有正式质量审批权限。
- 所有 GET/流式 Range/衍生物/打印二次请求都重新校验 release-level access，不能只在首次获取 URL 时鉴权。

## 8. API 请求/响应建议

| 方法 | 路径 | 关键字段与结果 |
|---|---|---|
| POST | /api/controlled-releases | `{approvedCandidateId,expectedRevision,idempotencyKey}` → preparing |
| POST | /api/controlled-releases/:id/validate | 发行物和审批链核验 → `{ready,blockers[]}` |
| POST | /api/controlled-releases/:id/scope-approval | `{approvedTargetDepartments:[...],quantities,authorityBasisId,expectedRevision}` → 冻结范围摘要 |
| POST | /api/controlled-releases/:id/issue | `{expectedRevision,idempotencyKey}` → `{releaseId,artifactIds[],sha256,state}` |
| POST | /api/distribution-batches | `{items:[{releaseId,artifactId}],targets:[{departmentId,receiverId}],policyVersionId}` → 冻结 manifest |
| POST | /api/distribution-batches/:id/dispatch | `{expectedRevision,idempotencyKey}` → 通知 outbox |
| GET | /api/distribution-batches/:id/targets | 分页、筛选与时间统计口径 |
| POST | /api/distribution-targets/:id/acknowledge | `{manifestSha256,statementVersion,expectedRevision,idempotencyKey}` → `{receiptId,actorId,signedAt,hash}` |
| POST | /api/distribution-targets/:id/decline | `{reason,expectedRevision,idempotencyKey}` → 拒收事件 |
| POST | /api/distribution-targets/:id/reassign | `{newReceiverId,authorityBasisId,reason,expectedRevision}` → 保留原接收责任 |
| GET | /api/distribution-targets/:id/receipt | 受控访问的完整签收凭证 |
| GET | /api/me/reading-assignments | 本人阅读待办 |
| POST | /api/reading-assignments/:id/confirm | `{artifactSha256,statementVersion,idempotencyKey}` → 本人确认时间/凭证 |
| POST | /api/controlled-releases/:id/activate | `{expectedRevision,idempotencyKey}` → 实际生效或 blockers |
| POST | /api/controlled-releases/:id/withdraw | `{reason,authorizationId,substituteReleaseId?,stopUseInstruction?}` |
| GET | /api/distribution-batches/:id/ledger | QP-01-JL02 对应发放/回收账及扩展个人明细 |
| POST | /api/controlled-copies/:id/collect | `{reason,expectedRevision,idempotencyKey}`，每次确认一份实体副本，实际回收人由服务端会话确定；多份批量回收须逐 ID 提供证据并原子核验 |

接口中的 `scope_id` 和 `time_zone` 应由服务器受控策略决定，不能任意由低权限客户端影响生效范围。批次签收返回的凭证只能算当前请求的 manifest，旧批次凭证不可在新批次复用。

### 8.1 签收接口体样例

以下 64 位全零 SHA256 仅为字段格式占位示例，不是真实文件/清单的摘要；实际请求必须提交服务端冻结清单计算出的 SHA256。

~~~json
{
  "manifestSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "statementVersion": "receipt-ack-v1",
  "expectedRevision": 3,
  "idempotencyKey": "client-uuid"
}
~~~

成功响应中的 `actualReceiverId` 和 `acknowledgedAt` 均由**服务端**产生：

~~~json
{
  "receiptId": "receipt_123",
  "targetId": "target_42",
  "actualReceiverId": "authenticated_user",
  "acknowledgedAt": "2026-10-15T06:00:00Z",
  "manifestSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "status": "acknowledged"
}
~~~

## 9. 发行/签收负面验收

- R-01：未批准源稿、未完成 Office 保存、哈希变化、未确认分发范围，不可发行。
- R-02：旧 publish 对纳管受控文件不能创建合法发行；普通非受控文件兼容。
- R-03：批准源 X、PDF 转换 Y、加章 Z、冻结 Q 全部可追溯，发行后章修订不改变 Q。
- R-04：部门看到清单 X 才能签 X，改动/替代后的清单不被旧 receipt 承认。
- R-05：通知已读/首次打开不算签收；阅读确认不算部门签收；均不算培训。
- R-06：用户调岗、接收人更换、代理授权过期后操作被拒绝，历史签收保持。
- R-07：同一目标并发签收幂等；重复/纠正操作保留事件链。
- R-08：A/2 已签收而 A/3 替代，A/2 留下 ack=acknowledged + validity=superseded。
- R-09：到计划生效时间但缺关键签收，actual_effective_at 为空、blockers 清楚。
- R-10：两个候选同 scope 同时激活，指针仍唯一；重启补偿不会双生效。
- R-11：纸质发放 5 收回 4，不得标记完成；电子分发不伪造纸质发放数。
- R-12：无培训程序时默认界面/报表不出现培训率、完成比例或生效门槛。
- R-13：发行物访问授权不扩张工作分支、历史文件、其他部门的访问权。
- R-14：紧急撤回后不存在可合法执行版时显示 no_effective_release，不擅自回滚。
