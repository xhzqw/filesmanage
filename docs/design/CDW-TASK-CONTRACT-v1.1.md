# CDW-TASK-CONTRACT-v1.1 — 任务树、工作组、多级派发和责任回签

> 隶属：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md`。仅设计，不表示 API、DDL 已存在。
> 已确认：逐级派发、独立文件分支、工作组负责人先接收后分配、固定清单、授权越级但中间责任保留。
> G1 字段级裁决：表名/实际字段/并发约束以 `CDW-G1-DDL-01-TASK-OFFICE.sql` 及 `CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md` 为准。旧版逻辑表、请求体 idempotencyKey 和 expectedRevision 描述均被 G1 统一 HTTP 头约定取代。

## 1. 模型边界和角色

任务不是文件审批和受控发行：`Task` 安排人员工作；`TaskAssignment` 表示一项具体责任的委派与接收；`Delivery` 是不可变交付；`ReviewGate` 是验收义务；`AccountabilityObligation` 表示某一上游人的管理/整合/回签/上报责任；`FormalApproval` 是独立流程。

| 角色 | 权责 |
|---|---|
| 任务发起者 | 创建根任务/定义接受标准；不能直接冒充所有正式批准 |
| 直接责任人 | 任务接收/拒收、分解给授权子级、汇总子级成果 |
| 工作组负责人 | 先代表工作组接收再授权指派成员；成员仅获得自己的任务访问权 |
| 执行人 | 持有工作分支、提交确定交付、按退回意见复修 |
| 逐级验收人 | 验收直接下级交付或整体汇总；不得更改已冻结交付 |
| 授权越级介入人 | 根据 `override_grant` 可检查/退回/替代特定 gate，但不得清空上游义务 |
| 正式审批人 | 在独立文件审批流程签批，不因 task role 自动授予 |

默认责任路径：发起者 → A → B → C；C 交付先由 B 验收，B 汇总再由 A 验收，最后发起者收到整体交付。用户明确授权越级时，可由指定高层直接审查 C，但 B/A 的其他责任依然显示待办。

## 2. 数据表逻辑草案与约束

| 表 | 主字段 | 约束/索引 |
|---|---|---|
| workflow_templates / workflow_template_versions | id、template_key、version、published_at、node_graph_json、role_rules_json | 实例按版本冻结；发布后定义不可变 |
| workflow_instances | id、template_version_id、root_task_id、scope_snapshot_id、status、revision | 角色解析/流程图快照不静默覆盖 |
| tasks | id、root_id、parent_id、subject_kind、subject_id、current_assignee_id、owning_group_id、state、round_no、revision | parent_id 同根、无环；禁止删除有历史的父任务 |
| task_assignments | id、task_id、assigner_id、assignee_id、group_id、kind、offered_at、accepted_at、ended_at、authority_id、reason | 单任务至多一个当前主要责任分配；会签/多人并行拆分为多个子任务或明确定义联合责任 |
| task_assign_events | id、assignment_id、event_type、actor_id、occurred_at、reason、prior_assignee_snapshot | 委派/接收/拒绝/调岗均追加记录 |
| task_manifest_versions | id、root_task_id、revision、manifest_sha256、frozen_at、actor_id、reason | 一次修改范围产生新 revision，不改旧版本 |
| task_manifest_items | manifest_version_id、file_id、path_snapshot、base_version_id、base_sha256、required、ord | 固定文件、版次与当时路径；删除/移动不重写历史 |
| deliveries | id、task_id、round_no、branch_revision_id、blob_id、sha256、submitted_at、actor_id、remarks | 完全不可变，可引用固定资料包多文件交付清单 |
| delivery_items | delivery_id、file_id、branch_revision_id、blob_id、sha256、task_manifest_item_id | 不跨版本隐式选“最新” |
| review_gates | id、task_id、delivery_id、node_key、responsible_id、review_mode、state、revision、required | 同交付可存在不同级别独立 gate |
| review_decisions | id、gate_id、round_no、actor_id、acting_for_id、override_grant_id、decision、reason、occurred_at | 只追加，可保留越级替代证据 |
| accountability_obligations | id、task_id、person_id、kind、source_assignment_id、state、waiver_approval_id | gate 跳级不自动标记管理/整合/上报完成 |
| return_orders | id、task_id、delivery_id、issued_by、assigned_to、reason、required_actions_json、due_at、created_at、round_no | 退回明确对象，旧交付不改 |
| override_grants | id、granter_id、actor_id、scope_kind、scope_id、allowed_actions、expires_at、reason、revoked_at | 有效期/范围/动作受限 |
| task_dependencies | task_id、depends_on_task_id、kind | 不能有环，强制依赖可阻塞开始/验收 |

索引建议：`tasks(parent_id,state)`、`tasks(current_assignee_id,state,due_at)`、`task_assignments(task_id,ended_at)`、`review_gates(responsible_id,state)`、`deliveries(task_id,round_no)`；对活动主责任使用部分唯一约束。

### 2.1 固定文件夹清单

- 创建时按授权能读取的文件冻结 `file_id + version_id + sha256 + relative_path_snapshot`，记录包含/不包含子目录、扫描时间和清单 SHA。
- 后续目录移动、删除或改名不改变冻结清单。不可用文件显示 `unavailable_or_no_access`，须人工处理，不自动跳过。
- 新增/移除文件通过 `manifest_revision` 申请，记录操作者、理由、受影响任务、对应交付范围与是否要求重新审批；旧版本可重现。
- 同名不同 ID 与相同 ID 不同基准版本不得悄悄合并；权限不能因快照而自动扩大。
- 资料包文控发行只采用**已批准且准备好的受控 release_id 清单**，不能把未批准的工作分支当作正式发布。

## 3. 状态机

| 任务现态 | 事件 | 次态 | 守卫 |
|---|---|---|---|
| draft | dispatch | assigned | 明确责任人/组负责人；目标有预览和任务权限 |
| assigned | accept | accepted | 指定人/组负责人主动接收；记录接收时间 |
| assigned | decline | declined | 必须填写理由，通知原派发人 |
| accepted | start | in_progress | 前置依赖满足且有有效分支或处理方式 |
| in_progress | submit | submitted | 所有必需交付完成、分支保存已确认、交付冻结 |
| submitted | return | returned | 有权 gate、理由、责任接收人 |
| returned | resume | in_progress | 新轮次，不改上一轮 delivery |
| submitted | accept_delivery | accepted_delivery | 所属 gate 通过；下一层义务按规则创建/通知 |
| accepted_delivery | close | closed | 上游必需管理/整合/汇总义务和 gate 已履行 |
| any nonterminal | cancel | cancelled | 授权、原因、下游关联处置方案和通知 |

禁止默认“向下派发即原任务已完成”或“C 已交付则 A/B 所有责任自动完成”。

### 3.1 多人同一文件

不同责任人提交同一文件的建议默认 `parallel_child_tasks`，分别绑定 branch_id。多个参与者对同一分支协作，必须显式 `collaboration_enabled=true` 并经参与者/权限审计。任务创建时可多接收人但每个交付来源与个人责任必须分辨，不能用“一份签收”覆盖所有人。

### 3.2 越级干预和退回

- 最小动作集合：`inspect`、`request_changes`、`substitute_review_gate`、`escalate`；**不包含 `approve_formal_document`**。
- 越级操作事务内验证 grant 有效、actor 匹配、file/task scope、gate 可替代且尚未做出最终决定。
- 替代 gate 时用 `review_decisions.acting_for_id` + `override_grant_id` 写明，不得假冒原审核人的签名或记录。
- B/A 的管理/整合义务保持 `pending`；可创建 `acknowledge_override` 的知悉义务以保证责任链透明，但不应与签收文件混淆。
- 退回后原交付为 `superseded_by_new_round`，新提交明确 `round_no+1`；旧批注与决策不可迁移成新轮次已完成。
- 被越级者可提出合理异议，建立 `review_challenges`（申诉者、target_decision_id、理由、裁定者/时间），不能擅自改写已完成的正式审批。

## 4. 事务边界和权限

事务内完成：加锁任务/活动分配 → CAS revision → 校验权限和依赖 → 写业务记录 → 追加审计/私有通知 outbox → commit；事务外发送实时通知。分配工作组时解析**当时有效的负责人**，记录组织角色快照；负责人变动不能改写过去签收任务的证据。

安全规则：派发不授予源文件夹全部权限；相关执行人仅获取明确文件与工作分支的最小权限。禁用、调岗、退出工作组之后对新请求立即重验；过期授权不能再操作。

**死锁与并发**：依赖图/父子树的写入按 root_id / task_id 稳定锁顺序；新增依赖需事务内检测成环，跨进程并发操作需在同一 root 上串行化；重试使用唯一请求键。

## 5. API 请求/响应样例（拟新增）

`POST /api/workbench/tasks`
~~~json
{
  "rootTaskId": null,
  "parentTaskId": null,
  "title": "XX设备技术报告修订",
  "assignee": {"kind": "workgroup", "id": "wg_xx"},
  "manifestVersionId": "manifest_v1",
  "templateVersionId": "tpl_v3",
  "idempotencyKey": "client-uuid"
}
~~~
返回 `201 {taskId, state:"assigned", revision:1, assignedTo:{kind,id}}`；若未授权，则 403，若清单失效则 422。

`POST /api/workbench/tasks/:id/accept`：`{expectedRevision, idempotencyKey}`；仅指派人/工作组有效负责人可接收。

`POST /api/workbench/tasks/:id/delegate`：`{assignee:{kind,id}, childTitle, manifestVersionId, expectedRevision, idempotencyKey}`；默认创建子任务，并保留父级整合责任，不用覆盖 current_assignee 实现伪转派。

`POST /api/workbench/tasks/:id/deliver`：`{branchRevisionIds:[...], manifestVersionId, expectedRevision, idempotencyKey}`；服务端解析/冻结每个 Blob，返回 `202 {deliveryId, state:"awaiting_review"}` 仅在所有保存栅栏已持久成功时允许。

`POST /api/workbench/review-gates/:id/decide`：`{decision:"accept"|"return", reason, overrideGrantId?, expectedRevision, idempotencyKey}`；服务端决策响应包含 `remainingObligations[]`，越级时不可全清。

`GET /api/workbench/inbox?filter=mine&cursor=...`：返回任务、验收、批准、签收、阅读异质待办，每项显式 `kind, subjectId, dueAt, status, allowedActions[]`，只有当前可见权限的数据。

## 6. 验收阻断

- T-01：A→B→C，C 交付后 B 未验收，A 不能把整包认作已完成。
- T-02：授权上级越级验收 C 后，B/A 管理与整合义务不消失，替代的审核人真实记录。
- T-03：工作组负责人接收前，组员无权接管全部组任务；接收后指派组员可追溯。
- T-04：固定清单派发后目录移动/删除/新建文件，原任务范围不自动变化。
- T-05：任务 DAG 并发循环创建失败，事务回滚且不留成功通知。
- T-06：两个分支交付互不覆盖；正式审批不自动批准未整合的候选稿。
- T-07：旧交付被退回后的历史仍可读但不被算作新一轮完成。
- T-08：管理角色变更与任务接收竞态，服务器以事务内有效资格为准。
