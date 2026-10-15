# SPEC-CDW-v1.0 — filesmanage 统一协同工作台与受控文件发行签收

> 文档版本：1.0.0-draft.1 · 2026-10-15  
> 状态：设计规格（待文控/质量部门核对现行受控原件，**未授权开发和部署**）  
> 上位规范：docs/SPEC-v2.1.md；遵守 AGENTS.md 的 UI、后端、权限与远端验收约束。  
> 参考依据：用户上传的《中晟生物科技各审批流程节点逐条梳理》13 页；文中“来源”与“产品决策/设计建议”必须分开。  
> 范围：ONLYOFFICE 在线修订、任务派发/逐级验收、正式审批、版本发行、部门签收、人员阅读、旧版回收、生效与审计。

## 0. 已确认决策与本期不做事项

| ID | 用户已确认决策 | 系统强制约束 |
|---|---|---|
| DEC-01 | 任务允许逐级派发 | 任务树与历次派发分离，A→B→C 可再分解，责任不自动转移或消失 |
| DEC-02 | 独立分支优先 | 不同任务修订同一文件采用独立工作副本；分支内协作需显式开启 |
| DEC-03 | 工作组负责人接收分配 | 组内成员不自动拥有整包编辑权 |
| DEC-04 | 文件夹固定清单 | 派发冻结文件 ID、基准版、相对路径；改范围形成清单新修订 |
| DEC-05 | 任务验收与正式审批分离 | 任务已完成不等于受控文件批准，批准不等于发行，发行不等于签收 |
| DEC-06 | 授权越级介入 B 方案 | 经授权替代目标验收节点，保留中间管理、整合、上报义务 |
| DEC-07 | 部门签收 + 相关人员阅读确认 B 方案 | 两种记录分别生成、统计、验证，不能互相替代 |
| DEC-08 | 历史版本可自定义名称 | 内部 vN、分支 rN、正式受控 A/1 等编号独立于显示名称 |

### 0.1 培训边界（特别裁定）

**本期不实现培训系统，不设默认培训步骤、培训达标率、培训完成率或培训作为文件生效前置条件。**

PDF 第 3 页 A2.2 的 QP-01-JL02 列的是发放/签收/日期/数量/回收等字段，**没有培训率**。第 13 页备注只是将「培训」作为未来可另行逐条展开的其他程序，不能据此创造强制培训要求。

- 本期必须实现：授权部门签收；按文控配置的使用人员名单主动「阅读/知悉确认」。
- 本期不做：个人培训、考试、课程、培训率及任何“打开文件=培训合格”的判定。
- 本期默认表格/统计只包含部门签收率、个人阅读确认率、旧版回收完成率，均须注明分子分母和例外项。
- 如以后获得实际培训受控程序，再建独立培训域，关联 release_id 与用户/岗位；不得把阅读记录冒充培训证据。
- 「个人阅读确认」默认**不阻塞**文件生效；仅经明确批准的发行策略可将指定人群的确认配置为生效门槛。

### 0.2 术语、权威状态与不变量

- 文件身份 file_id 恒定；内部历史版本 seq 追加式不可变。
- 工作分支 BranchRevision 可以编辑后形成新修订；Delivery 必须引用具体已持久化 Blob 和 SHA256。
- Approval 是正式业务批准，不是任务的直接验收。
- ControlledRelease 是某个已批准文件版本的正式受控发行快照。
- DistributionBatch 是一次确定的分发行为；Target 是其中一个接收部门；Receipt 是该部门指定接收人主动操作的签收证据。
- ReadingAssignment 是某位实际使用人的阅读义务；不等于部门签收，不等于培训。
- EffectiveRelease 是已实际生效的受控发行；不等于最新上传或最新已批准版本。

**INV-01** 工作稿保存 / 任务验收 / 正式批准 / 受控发行 / 分发通知 / 部门签收 / 个人阅读 / 生效 / 回收必须分别记账。  
**INV-02** 任何签收必须绑定发行 ID、文件内容哈希和签收人；旧版不能冒充新版。  
**INV-03** 任何已提交交付与发行产物不能被后续 ONLYOFFICE 自动保存静默替换。  
**INV-04** 已越级验收 C 不自动将 B、A 的责任置为 completed。  
**INV-05** 系统管理员权限不能自动当作受控文件的合法签批或部门代理资格。  
**INV-06** 同一适用范围内的同一受控文件不能出现两个当前有效版本。  
**INV-07** 审批、签收、回收、撤销、更正留不可变事件；不要覆盖或删除原历史。

## 1. 与 PDF 的逐项关系（有依据 ≠ 自动制度化）

| 来源 | 原文要点 | SPEC 处理 |
|---|---|---|
| 第 1–2 页 A1.1 | 质量手册、QP、WI、技术文件的编制/审核/批准权限不同 | 根据文件类别选择流程模板，最终具体角色待原件核对 |
| 第 2 页 A1.3 | 技术文件 DMR 文控标准化审核、编号、D7 前后不同批准角色、受控下发 | 单独 DMR 模板、阶段条件 |
| 第 3 页 A1.5 | 字母版本+数字版次，例如 A/1 | 独立受控版次；变更幅度只作提示，不替代授权确认 |
| 第 3 页 A2.1–A2.2 | 文控员发放、各使用部门签收，QP-01-JL02 发放/回收字段 | 部门签收主表、详细时间、人、数量、回收台账 |
| 第 4–5 页 A3.2–A3.4 | 变更/作废申请、原审批部门或指定部门批准、文控更改发放、旧版回收 | 变更申请、审批证据、发行、回收闭环 |
| 第 7–8 页 C2–C4 | 设计更改需评审/验证/必要确认，ECN 明确受影响文件及执行信息 | 独立可配置工程更改模板 |
| 第 13 页 | 差异以公司现行受控文件版本为准；培训只是另待梳理主题 | 不把培训或培训率纳入本期默认制度 |

**待核对**：材料中的 QS-QP-01 / ZS-QP-01 编号差异、各级准确签核责任、文件保存期、线上电子签收能否替代纸质签字、是否需独立批准纸质章样式；不能凭当前梳理稿认定全部生效。

## 2. 端到端文件生命周期

1. 发起文件新增、修订、保留或作废申请；记录文件、正式基准版、原因、变更范围与来源任务。
2. 创建对应任务及 ONLYOFFICE 工作分支。多个执行人优先各自隔离，明确启用协作才同分支编辑。
3. 只有服务端确认 ONLYOFFICE 最新保存已经持久化，才允许冻结交付（Delivery→Blob/Hash）。
4. 子任务逐级验收；退回生成新提交轮次并保留旧交付；越级仅替代授权的指定验收义务，中间管理/整合/上报义务仍须履行。
5. 正式审查、审核、批准绑定确定候选稿和证据；批准不自动发布、分发或修改生效版本。
6. 文控核验发行条件：文件编号、受控版次、已批准文件/文件哈希、正式发行产物、生效策略、目标部门与旧版处置要求。
7. 文控正式发行形成独立 release_id；分发时冻结部门清单并为授权接收人创建待办。
8. 接收人查看绑定的受控版本，主动确认部门收到；服务器记录人、时间、内容哈希、授权、声明。
9. 根据分发策略对名单快照内的相关人员创建阅读任务。打开记录、阅读确认和部门签收均各自独立。
10. 生效守卫按实际配置检查计划时间及强制条件；生效后受控默认入口切换新版，旧版退出常规执行入口。
11. 纸质旧版副本回收与电子版本撤回分别跟踪；全部历史审批、签收和回收可反向查询。

追溯链：File → BranchRevision → Delivery → Approval → ControlledRelease → DistributionBatch → DistributionTarget → DepartmentReceipt / ReadingAssignment → Activation / Withdrawal。

## 3. 受控发行状态机

| 现态 | 操作 | 次态 | 守卫 |
|---|---|---|---|
| preparing | 文控核验 | ready | 源审批已通过、发行内容/哈希正确、编号/版次合规 |
| ready | 正式发行 | released_pending_effective | 文控业务授权、签署产物与生效策略完整 |
| released_pending_effective | 生效检查通过 | effective | 已到计划日期 + 所有实际配置的必需条件满足 |
| released_pending_effective | 条件不足 | 原状态不变 | 仅记录 blockers，不允许写入实际生效时刻 |
| preparing / ready | 取消 | cancelled | 追加理由；不得存在有效发行 |
| released_pending_effective | 撤回 | withdrawn | 授权及后续执行依据 |
| effective | 新版切换 | superseded | 新版已经合法生效，旧版历史不变 |
| effective | 紧急撤回 | withdrawn | 明确使用范围、原因、通知及替代执行依据 |

- planned_effective_at 与 actual_effective_at 是两个独立字段。
- release_id 绑定一个不变的 version_id、approval_id、受控版次、发行内容 SHA256；发行后禁止变更内容及编号。
- 允许自定义显示名称，但原始版本编号、发行时显示名称快照、内容哈希和审批证据不能被更名改写。
- 同一适用范围（默认全局）同一文件只能有一个 effective release；不同部门签收进度本身不生成多套正式有效版。
- 发行和审批必须校验职责分离；不能直接把当前 SetFileLifecycle("publish") 视为所有发行前置条件都完成。

## 4. 生效策略（培训不在范围内）

| 策略 | 是否本期支持 | 默认 |
|---|---|---|
| scheduled：受控批准/发行并达到指定日期 | 必须 | 普通文件默认 |
| key_dept_ack：必须完成指定关键部门的部门签收 | 必须 | 未确认文件类别时默认关闭 |
| manual_activation：条件满足后由有权负责人确认生效 | 必须 | 按文件类型配置 |
| required_reading：明确的指定人员阅读确认才生效 | 可支持 | 默认关闭 |
| training_gate / training_rate | **本期不支持** | 永远不自动启用 |

CanActivate = approved ∧ issued ∧ time_reached ∧ mandatory_gates_satisfied ∧ no_blocking_disputes ∧ effective_scope_valid。

允许分发给非关键部门后继续催收，不因非强制目标未签而冻结整个公司文件。重要文件如现场需要先准备，再由文控依据正式批准的策略配置关键签收或人工生效条件；PDF 未规定全类文件必须采用同一套。紧急撤回不得假定可自动恢复旧版执行，必须有明确的受控执行依据或停止使用指令。

## 5. 部门签收 / 个人阅读状态机

### 5.1 部门 Target

状态：pending_dispatch → awaiting_ack → acknowledged。awaiting_ack 也可进入 declined / exception，经授权改派/重新通知再次 awaiting_ack。未完成目标被新版取代为 superseded，发行撤回为 withdrawn。通知 queued/delivered/failed 应单独记录投递状态，不能用 delivered 替代 acknowledged。

部门的四个不同时间：通知送达 delivered_at、首次打开 first_opened_at、正式签收 acknowledged_at、部门实施 implemented_at。**仅 acknowledged_at 对应的、已验证授权用户主动确认才算部门正式签收**。

指定接收人与实际签收人分别记录，允许有证据的授权代理；不得让普通成员替整个部门签收。更正/撤销必须追加事件，不能直接删除原凭证。

### 5.2 个人 ReadingAssignment

状态：assigned、opened、confirmed、exception、cancelled。阅读名单创建时冻结用户与岗位快照；后续增减通过新的 roster_revision 及事由，不以今天部门人数重算昨天的分母。打开不等于主动确认；confirmed 不等于受控培训合格，也不能自动确认部门目标。可记录确认文字快照及个人操作服务端时间。

### 5.3 默认统计定义

- 部门签收率 = 当前要求正式接收且有效的部门目标中已签收的数量 / 当前必需部门目标数量。
- 个人阅读确认率 = 当前有效阅读义务中确认完成的数量 / 当前要求完成的阅读义务总数。
- 旧版回收完成率 = 应执行回收的目标中有效完成的数量 / 必需回收目标总数。
- 拒收、撤回、不适用、获准豁免、逾期与异常分别计数；历史统计须可按当时名单快照/时间点复现。
- **禁止出现培训率、培训达标人数、培训进度等没有数据源的指标。**

## 6. 电子旧版撤回和纸质副本回收

- 电子版：新有效版生效后，普通受控入口默认指向新版；旧版保留，只对有历史访问权限者展示“已失效/不得作为当前执行依据”，下载和打印按权限策略控制；系统不声称能远程删除既有本地副本。
- 纸质版：登记副本编号、当时发放的部门/持有人、发行版次、发出数量、实际收回数量、回收人、时间、回收原因及后续处置（销毁、留存、异常）。
- 回收状态：not_required / pending / in_progress / completed / exception / waived。waived 需要合法授权与理由。
- 纸质发放 5 份仅回收 4 份，不能因为人员按了按钮就显示全部完成。
- 纯电子分发无纸质副本时，不允许填虚假的“发放纸质数量 1 份”。
- 旧版回收是否阻塞新版本生效，仅按经核对的文件类别发行策略配置；无明确强制要求时保留回收待办而不是无限阻塞。
- 异常发行撤回必须保留原签收、通知和发行证据，追加纠正与重新分发事件。

## 7. UI：以详细签收表格作为主界面

页面 /workbench 下的「受控分发」「签收台账」与「我的待办」相互联通；从预览的文件受控版本可以跳转对应发行详情。预览右侧不堆大表。统一采用冷灰 #F2F4F7 底座、12px 内嵌白画布、RareUI 控件、紧凑行、可滚动表格及可折叠详情。

**分发批次表头**：文件名称、文件编号、受控版本、发行日期、计划生效、实际生效、应签部门数、已签、拒签/异常、待阅读人数、旧版待回收数。

**部门签收主表（默认列）**：接收部门｜指定接收人｜实际签收人｜发放时间｜**签收时间（到秒）**｜签收状态｜已读/应读人数｜旧版回收状态｜异常。

**行展开详情**：
1. 部门接收：发行版次、固定文件哈希、发放人、通知送达、首次打开、指定/实际接收人、代理依据、正式签收服务端时间、确认声明、凭证 ID。
2. 人员阅读：员工、岗位、首次打开、确认时间、状态、是否异常；**不设培训率列**。
3. 回收与实施：旧版标识、纸质副本编号/数量、回收人、回收时间、异常原因及实施确认（如适用）。
4. 事件时间线：发送、重试、首次打开、签收、拒收、改派、更正、阅读、回收、发行状态变化。

表格支持按文件/部门/批次切换、状态和时间筛选、服务端排序/分页。批量提醒可支持，但**禁止批量代签收或将已读消息批量设为阅读确认**。历史 QP-01-JL02 对应报表保留文件名称/编号版本、部门签收日期数量、回收原因/人/日期/备注字段，增加明细扩展页；未发生时间真实留空。

## 8. 数据模型（建议，尚未执行 migration）

| 表 | 关键字段 | 保证 |
|---|---|---|
| controlled_document_profiles | file_id、document_code、document_type、owner_department_id | 文件编号类别、归属 |
| document_change_requests | id、file_id、base_release_id、change_kind、task_id、reason | 变更审批来源 |
| controlled_releases | id、file_id、version_id、approval_id、controlled_revision、source_sha256、display_name_snapshot、planned_effective_at、actual_effective_at、supersedes_release_id、policy_snapshot_id、state、revision | 发行内容固定、明确版本继承 |
| controlled_release_artifacts | id、release_id、kind、blob_id、sha256、size_bytes | 受控 DOCX/PDF 产物不可变 |
| distribution_policies | id、version、target_rules、ack_rules、effective_rules、withdraw_rules | 政策版本化 |
| distribution_batches | id、release_id 或 package_manifest_id、policy_snapshot_id、dispatched_at、actor_id | 固定分发范围 |
| distribution_targets | id、batch_id、department_id、department_name_snapshot、designated_receiver_id、status、revision | UNIQUE(batch_id, department_id) 或显式重复派发模型 |
| department_receipts | id、target_id、release_id/manifest_id、actual_receiver_id、authority_basis_id、acknowledged_at、statement_snapshot、artifact_sha256、receipt_hash、request_id | 一个目标至多一项当前有效正式签收 |
| reading_rosters | id、target_id、revision、frozen_at | 使用人员清单快照 |
| reading_assignments | id、roster_id、user_id、requirement、status、revision | 每个用户独立确认 |
| reading_events | id、assignment_id、event_kind、actor_id、occurred_at、content_sha256 | 查看和确认事件分离 |
| controlled_copies | id、release_id、copy_no、holder_id、department_id、issued_qty、state | 纸质副本 |
| withdrawal_events | id、old_release_id、copy_id、target_id、qty、event_kind、actor_id、reason、occurred_at | 回收及异常 |
| activation_decisions | id、release_id、scope_id、actor_id、result、effective_at、blockers_snapshot | 发行生效可审计 |
| controlled_release_events | id、release_id、kind、actor_id、payload、occurred_at | 追加式事件审计 |

模板使用 WorkflowTemplate + DistributionPolicy 双层版本快照。任务和验收继续使用此前提出的 task、delivery、review_gate、accountability_obligation 结构；不要用受控签收表来承担逐级任务责任。

**并发不变量**：发行与同适用范围生效必须在数据库事务中锁定相应文件/范围并比较预期修订；签收、派发、阅读确认、回收采用 Idempotency-Key；每个操作记录事务内业务事件和通知 outbox。服务器用 UTC 保存时间，客户端按时区显示。签收人从鉴权会话获取，不能信任客户端自报。保留期内的 Blob 不能因 GC 丢失。

### 8.1 和既有 filesmanage 模块的兼容

- migrations/0001_core.sql 中 files.current_version_seq 是正式历史指针；不能直接认为它就是当前执行版。
- migrations/0022_file_lifecycle.sql 目前只有 released / archived 及 published_seq 等摘要；保留旧接口兼容，新发行作为独立领域，不把所有记录塞进该表。
- internal/application/approvals.go 的最终批准追加 file_versions；新增发行须另核验 approval_id/哈希/批准资格，禁止仅凭文件修改权限完成文控正式发行。
- migrations/0018_approval_chains.sql 的顺序审批链限定最多五节点，不能承载无限任务子树或多部门并行签收；新模板需独立节点/边表。
- web/src/shared/featureFlags.ts 生命周期页面默认受环境开关限制；新工作台按阶段接入，避免两套并存且互相矛盾的受控发行状态。

## 9. API 契约草案

所有写接口：登录用户、服务器鉴权、Idempotency-Key、expectedRevision 或 If-Match；403/404 不泄漏无权资源，409 代表并发/版本冲突，422 代表不满足业务守卫。成功事务提交后才通过持久通知事件推送。

| 方法 | 路由 | 功能 |
|---|---|---|
| POST | /api/document-changes | 新建文件变更申请 |
| POST | /api/controlled-releases | 已批准候选稿→发行准备 |
| POST | /api/controlled-releases/:id/validate | 文控核验 |
| POST | /api/controlled-releases/:id/issue | 正式发行，固定版次/产物 |
| POST | /api/controlled-releases/:id/activate | 生效条件核验与状态切换 |
| POST | /api/controlled-releases/:id/withdraw | 受控撤回并记录后续执行依据 |
| GET | /api/files/:id/effective-release | 取当前受控执行版 |
| GET | /api/files/:id/release-history | 全部发行历史 |
| POST | /api/distribution-batches | 固定 release 和目标部门 |
| POST | /api/distribution-batches/:id/dispatch | 发送指定版本到部门 |
| GET | /api/distribution-batches/:id/targets | 部门表格，服务端过滤/分页 |
| POST | /api/distribution-targets/:id/acknowledge | **实际授权用户主动部门签收** |
| POST | /api/distribution-targets/:id/decline | 拒收及原因 |
| POST | /api/distribution-targets/:id/reassign | 改接收责任人，保留代理/历史 |
| GET | /api/distribution-targets/:id/receipt | 证据详情 |
| GET | /api/distribution-batches/:id/ledger | QP-01-JL02 对应记录 |
| GET | /api/me/reading-assignments | 个人阅读待办 |
| GET | /api/distribution-targets/:id/readers | 指定部门个人阅读明细 |
| POST | /api/reading-assignments/:id/confirm | 个人阅读确认，不是培训 |
| POST | /api/distribution-targets/:id/roster-revisions | 调整阅读范围并留痕 |
| GET | /api/controlled-releases/:id/withdrawals | 旧版撤回情况 |
| POST | /api/controlled-copies/:id/collect | 受控纸质副本回收 |
| POST | /api/controlled-copies/:id/dispose | 销毁或留存证据 |
| POST | /api/withdrawal-records/:id/exception | 回收异常 |
| POST | /api/distribution-targets/:id/implementation | 按策略确认现场实施 |

工作台 read-model 聚合待办：个人任务、待验收交付、正式审批、部门签收、个人阅读和旧版回收异常；不能把“通知已读”转换成“任务履行”。

## 10. 角色与签收权限

| 角色 | 允许 | 禁止冒充 |
|---|---|---|
| 编制/执行人 | 分支编辑、交付提交 | 正式批准、部门代签 |
| 任务验收人 | 按授权验收具体提交 | 正式文件签批 |
| 越级责任人 | 在被授权节点范围内介入 | 自动免除 A/B 中间责任 |
| 正式批准人 | 批准固定候选文件 | 文控发行和部门签收 |
| 文控发行人 | 准备/签发受控版本、定向分发、管理回收 | 接收部门用户的签收操作 |
| 部门授权接收人 | 对授权部门与指定版本签收、拒收、报告异常 | 任意代签其他部门 |
| 指定阅读人 | 查看指定发行、主动确认阅读 | 代签整个部门 |
| 管理员 | 系统管理、技术恢复 | 无额外业务授权时越级签批/签收 |

代理签收记载指定接收人、实际操作者、授权凭证及当时职位快照。浏览器能记录服务器验证的 IP/会话上下文；硬件 MAC 无法通过普通网页可靠采集，不作为必需签收证据。电子签收是否等同现有纸质签字须文控/质量确认。

## 11. 模板（固化 + 版本化）

| 模板名 | 核心节点 | 对发行/签收的要求 |
|---|---|---|
| QMS-NEW 体系文件新增 | 编制→审核→批准→文控发行 | 使用部门按类别分发 |
| QMS-CHANGE 文件修订/改版 | 变更申请→在线修订→再审核/批准→发行 | 新版签收、旧版回收独立 |
| TECH-DMR 技术文件 | 编制→文控标准化与编号→按 D7 阶段审批 | 仅有效受控版作为生产执行版 |
| ENGINEERING-CHANGE 工程更改 | 更改申请→影响评估→评审验证确认→批准→ECN | 特定部门定向通知/签收，保留实施信息 |
| FOLDER-PACK 资料包 | 组负责人接收→逐级任务→整合验收→正式审批 | 固定清单内每份受控发行 ID |
| DOCUMENT-ACK 受控分发 | 文控发行→部门签收→可选个人阅读→按政策生效 | **无培训率/默认培训节点** |

模板拥有 template_id + template_version、节点 DAG、角色解析、并行/串行、可替代性、跳级规则、拒绝退回路径、策略快照。执行中流程固定模板版本；升级需正式迁移事件。普通任务默认逐级回签，授权越级仅替代允许的验收节点，受控法定/独立审批节点不能被普通越级权限跳过。

## 12. 验收用例（全部基于真实持久化与后端鉴权）

| 编号 | 场景 | 正确行为 |
|---|---|---|
| CDW-01 | ONLYOFFICE 工作稿保存 | 不自动批准/发行/签收 |
| CDW-02 | C 交付由领导越级验收 | B、A 管理/整合责任仍未完成 |
| CDW-03 | 未经正式批准尝试发行 | 后端拒绝且不留成功发行事件 |
| CDW-04 | 审批通过但未发行 | 当前生效版不变 |
| CDW-05 | 已发行但未到计划生效日期 | 旧有效版保持，尚未生效 |
| CDW-06 | 到期但强制条件不足 | 不填 actual_effective_at、提示 blockers |
| CDW-07 | 通知到达或首次打开 | 部门仍待签收 |
| CDW-08 | 部门授权接收人主动签收 | 绑定版本哈希/人/服务器时间/声明 |
| CDW-09 | 代理签收 | 指定人和实际代理人清晰区分 |
| CDW-10 | 部门签收但个人未读 | 只完成部门签收，人员待办保留 |
| CDW-11 | 所有人已读但部门未签 | 不算部门签收 |
| CDW-12 | 点击打开/已读消息 | 不自动算个人阅读确认或培训 |
| CDW-13 | 默认模板/报表/主界面 | 无「培训率」「培训达标」或默认培训节点 |
| CDW-14 | 发放 5 份纸质旧版仅收回 4 份 | 保留 1 份待回收和责任人 |
| CDW-15 | A/2 未签完又发行 A/3 | A/2 签收不能冒充 A/3 |
| CDW-16 | 两个并发签收或重试 | 只产生一份当前有效正式签收 |
| CDW-17 | 双重生效并发 | 同一文件/范围最多一个当前有效版 |
| CDW-18 | 后续版本改显示名称 | 原受控版次、内容哈希、历史凭证不变 |
| CDW-19 | 资料包批量分发 | 固定每份文件 release_id 与清单哈希 |
| CDW-20 | 无权请求部门签收明细 | 后端不得泄露人、文件与签收内容 |
| CDW-21 | 人员离职/调岗 | 追加改派及名单快照，不删历史 |
| CDW-22 | 旧版被撤回 | 历史签收保留，当前执行依据明确 |
| CDW-23 | WebSocket 离线重连 | 根据持久事件恢复待办/状态 |
| CDW-24 | 输出 QP-01-JL02 | 列项与真实事件对应，缺失绝不补造 |

G0：文控/质量核对原件、签收制度、签批角色与生效策略；待核对条目不擅自落实。  
G1：状态机、DDL、API、权限与报告口径冻结。  
G2：单文件「批准→发行→部门签收」闭环和审计。  
G3：人员阅读、旧版回收、版本生效冲突、异常处理。  
G4：资料包、固化模板、多部门并行、越级责任链。  
G5：远端数据库事务/并发/权限/浏览器/报表复核；经用户批准才部署。

## 13. 实施边界与待裁决项

1. 待核对何类文件必须纸质回收、何类关键部门必须完成签收才能生效。
2. 待核对数字化签收取代纸质签字所需的公司程序更新和认证方式。
3. 待核对质量手册、QP、WI、DMR、ECN 的批准资格与特殊附件，不能以 PDF 梳理取代受控原件。
4. 待核对保存期限与文件编号策略。任何保留期内的审核/签收/回收 Blob 不得被 GC。
5. 培训若未来另行研究，需先提供实际培训受控程序；**本期无培训系统、无培训率、无培训阻塞生效要求。**

**本文件只新增设计规格，不包含开发授权、数据库迁移、提交/推送或部署指令。**
