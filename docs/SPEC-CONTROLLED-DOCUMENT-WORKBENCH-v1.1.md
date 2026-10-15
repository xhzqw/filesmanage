# SPEC-CDW-v1.1 — filesmanage 协同工作台与受控文件全生命周期

> 版本：1.1.0-draft.1 · 2026-10-15 · 状态：工程设计草案 / G0 与 G1 待验收
>
> 本版**替代 V1.0 的冲突条款**，保留 `docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.0.md` 作为历史基线。所有新增 API、表、事件与页面均为**设计合同，不代表已实施**。
>
> **本次仅写 SPEC，不修改任何业务代码、迁移、部署或已有历史数据。**
> **G1 设计增补（2026-10-15）：** `docs/design/CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md` 与 `CDW-G1-DDL-01-TASK-OFFICE.sql`、`CDW-G1-DDL-02-RELEASE-DISTRIBUTION.sql` 对数据库、事务、API 和受控发行 ID/全局生效规则享有优先解释权；它们仍是**未运行、未执行的草案**。用户确认本系统是测试阶段，旧数据回填/迁移/长期兼容要求不再适用。

## 0. 文档体系、优先级与事实标识

- 总规范：本文件（业务不变量、跨域接口、产品验收、迁移与 P0 收口）。
- 任务与责任合同：`docs/design/CDW-TASK-CONTRACT-v1.1.md`。
- 编辑分支与版本读取合同：`docs/design/CDW-VERSION-OFFICE-CONTRACT-v1.1.md`。
- 正式发行与签收合同：`docs/design/CDW-RELEASE-DISTRIBUTION-CONTRACT-v1.1.md`。
- 测试阶段 Clean Start / G1 事务与 DDL：`docs/design/CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md`、`docs/design/CDW-G1-DDL-01-TASK-OFFICE.sql`、`docs/design/CDW-G1-DDL-02-RELEASE-DISTRIBUTION.sql`；旧 `CDW-MIGRATION-ACCEPTANCE-v1.1.md` 仅供历史讨论，不再作为实施门禁。
- 上位基础：`docs/SPEC-v2.1.md` 和 `AGENTS.md`。对现行受控程序的有效性，应以文控/质量核验后的原件为准，而不是以任何软件草案覆盖制度。

**规范标识**：[U] 用户已确定；[P] 用户上传流程梳理明确包含；[D] 为达到目标提出的技术/产品设计，待冻结；[V] 待现行受控原件核对；[L] 仓库只读核对事实。不同等级不能互相替代。

### 0.1 不可变用户决策 [U]

| ID | 约束 |
|---|---|
| U-01 | 默认逐级派发，可层层转派给人或工作组；组任务先由负责人接收再分配。 |
| U-02 | 同一文件多人工作优先独立分支；同一分支需明确打开协作才允许多人实时编辑。 |
| U-03 | 文件夹任务冻结具体文件 ID、路径、基准版本、适用范围的清单，不跟随目录动态漂移。 |
| U-04 | 层层验收、回签；验收与正式批准相互独立。允许授权越级介入但不自动免除中间责任。 |
| U-05 | 正式版本可自定义显示名称，内部版本顺序号与受控版次独立。 |
| U-06 | 新版正式批准后再由文控发行、定向给部门；部门签收加相关人员阅读确认，记录实际人和精确时间。 |
| U-07 | 发行、签收、生效、旧版回收、历史审批记录必须可追溯；默认工作台汇总任务与审批。 |
| U-08 | 培训不在本期：无培训率、培训达标数、默认培训节点或培训强制生效守卫。 |

### 0.2 文件依据与未决制度 [P/V]

用户提供《中晟生物科技各审批流程节点逐条梳理》（13 页）是参考材料，**不能取代现行受控原件**：

| 梳理位置 | 该材料中列明的内容 [P] | 转化方式 |
|---|---|---|
| 第 2–3 页 A1.3/A1.5 | DMR 不同阶段批准规则；A/1 等版次 | 模板的阶段/版次配置，准确岗位 [V] |
| 第 3 页 A2.1 | 文控员制定受控总览表；管理者代表规定使用部门及数量；文控员原件章/受控文件章；统一发放；各部门签收 | **发行范围确认与发放数量是独立节点**；电子等效性 [V] |
| 第 3 页 A2.2 | QP-01-JL02：文件名、编号/版本、发放部门/签收/日期/数量、回收原因/人/日期、备注 | 原字段保持语义；电子扩展显示到秒与签收凭证 |
| 第 3–4 页 A2.3–A2.4 | 复制借阅查阅/补发；外来文件目录、分发及旧标准回收 | V1.1 明确保留既有流程，单列后续合同；不能被随意打印绕过 |
| 第 4–5 页 A3 | 文件更改/保留/作废表 QP-01-JL03，原审批部门或指定部门批准，旧版收回；作废通知、销毁、留存 | 变更/撤回/回收链和独立证明；保存期限/对象核对 [V] |
| 第 13 页备注 | 培训属于可进一步梳理的其他程序 | **没有培训率制度依据**，不纳入本期 |

必须提交给文控/质量确认：[V-01] 电子签收是否替代纸质签字；[V-02] 正式批准/分发范围的有效角色；[V-03] 原件章/受控章电子标识是否等效；[V-04] 文件类别的必需签收与生效条件；[V-05] 保留期限和外来文件、纸质复制/借阅/补发制度。

## 1. 审查 P0 整改表（开发前必须各自具备设计闭环）

| 问题 | 已核对事实 [L] | V1.1 的阻断规则 | 合同 |
|---|---|---|---|
| P0-A 旧发布绕过 | `internal/application/file_lifecycle.go:93–225` 的 publish 走修改权限/版本/锁等检查，未绑定正式批准凭据 | controlled 文档不得由遗留 publish 直接标记为新制度合法发行；统一发行命令校验 `approval_id` + 文件哈希 + 文控授权；非受控仍兼容旧行为 | RELEASE §2、MIGRATION §2 |
| P0-B 已批准提前可见 | `internal/application/approvals.go:255–303` 最终通过会追加 file_versions 并更新 current_version_seq | 正式历史最新版≠当前执行受控版；所有读取目的经同一版本解析器处理，文件当前执行版不由 current_version_seq 推导 | VERSION §2、MIGRATION §3 |
| P0-C 独占 Office | `internal/application/office.go:52–121,493–583` 会话按 file_id 独占且回调会追加正式文件版本 | 正式工作分支会话按 branch_id/session_id 管理，回调仅提交分支修订；同分支协作需显式共享，不得进入正式 file_versions | VERSION §3–5 |
| P0-D 单待审候选 | `migrations/0001_core.sql:80–92` 仅允许 file_id 一个 pending 审批 | 任务交付和候选稿并行；正式批准集中通过候选整合/准入节点；测试阶段将 managed 文件审批写端收敛到新流程，不保留双权威 | TASK §3、RELEASE §2 |
| P0-E 实际发行物未冻结 | 已有 `file_seal_revisions` 与 `CurrentSignedPDFForDownload` 可产生动态签章修订视图 | 批准源稿、转换、受控章和最终发行 Blob 分别哈希；部门只能签收固定实际发行物 | RELEASE §3 |
| P0-F 固定资料包未规范化 | V1.0 有 `release_id OR manifest_id` 的模糊描述 | 一切分发批次必须具有冻结的 batch_items 集合（单文件视为 1 项）；签收绑定清单摘要和版次 | RELEASE §4 |
| P0-G 回收/删除保留 | `internal/application/trash.go:189–228` 当前删除检查偏向原生命周期状态 | 新发行/签收/审计 Blob 有独立法律保留与引用保护；当前工作区移除不能破坏有效受控证据 | MIGRATION §4 |

**NO-GO**：上述任一条没有签审通过的字段、交易边界、失败和负面验收，不允许开始其依赖的受控发布实现。

## 2. 核心不变量（全模块统一）

1. `file_id` 代表文件身份；`file_versions.seq` 是旧体系已提交历史；`branch_revision_id` 为私有工作修订；`delivery_id` 为交付快照；`approval_id` 为正式批准；`release_id` 为受控发行；`artifact_id` 是最终发行物；`batch_id` 是分发批次。任何两个 ID 不得凭“最新”间接代替。
2. **已交付/已批准/已发行** 的内容（Blob + SHA256）不可覆盖，任何重新转换、签章或纠错必须生成新的受控产物和事件，按批准的修订策略处理。
3. **越级替代审查责任 ≠ 移除上游负责人的整合、知悉、管理和交付责任**；职责必须建模为独立义务。
4. 部门签收只有一个被授权用户主动签收的有效凭据；通知送达、首次查看、个人阅读确认、实施确认分别记录。
5. 电子分发不能自动假定完成纸质发放/旧版收回，不得填造 QP-01-JL02 数量、签收和回收时间。
6. V1 一份受控文件只允许一个**全局**当前有效 `release_id`，指针主键为 `file_id`；计划生效时刻≠实际生效时刻。部门级不同生效范围留到 V2。
7. 已批准而未生效的文件不能经普通预览/下载/打印/索引/链接泄露；有审查权限的用户仅通过显式审批/工作分支上下文访问。
8. 不迁移、不回填旧测试数据；新系统自开始运行起严禁伪造审批、文控发行和电子签收证据。任何清库/删除 Blob 都需要另行明确授权。
9. 数据库审批/发行/签收事务与事件 outbox 同提交；WebSocket 只是增量失效通知，不能作为审计记录或正确性前提。
10. 操作权限是 `actor + action + resource + file/release scope + organization role + validity` 的交集；技术管理员不自动拥有业务审批或代签资格。

## 3. 业务主线与阶段性承诺

### 3.1 任务到正式执行版

`ChangeRequest → TaskTree → BranchRevision → Delivery → ReviewGate → FrozenApprovalSubject → FormalApproval → ApprovedCandidate → PreparingRelease(固定 release_id / artifact) → FrozenDistributionPlan → ScopeApproval → Issue(同一 release_id) → DistributionBatch → DepartmentReceipt / PersonalReading → Activation → PreviousVersionWithdrawal`。

- 已完成任务交付可有多稿，整合候选必须固定完整来源清单及基线，不允许对仍有悬挂保存的草稿直接批准。
- 正式批准与任务验收分别进入各自状态机。
- 「受控分发范围确认」记录由谁批准目标部门及副本数量，材料中为管理者代表，实际岗位/电子数量须现行受控原件确认。
- 新版实际生效后，旧版可以保留回收待办但不能冒充已收回。模板有硬性回收前置要求时则阻止生效。
- 文件夹工作包可为若干个独立 release 形成同一分发批次，但逐文件批准与内容哈希仍必须完整。

### 3.2 生效策略

本期计划支持 `date_only`、`key_department_ack`、`manual_authorized_activate`，可选 `required_reading`（默认关闭）。**没有 `training_gate`。** 计划生效到期只触发后端幂等检查，不允许用户浏览器时钟决定切换。

### 3.3 历史与异常

- 旧版撤回/被替代/紧急撤回不能删除任何当时的已签收记录。
- 无合法生效版时返回业务状态 `no_effective_release`，不可悄悄回退旧版。
- 附件/证据版本无法读取时必须明确标为“证据不可用”并阻断依赖操作，不能退回文件的当前最新版。
- 跨角色代理、拒收、逾期、失效、驳回、模板迁移必须显式审计。

## 4. 五个独立状态轴

| 状态轴 | 例举状态 | 权威来源 |
|---|---|---|
| 执行任务 | drafted/assigned/accepted/in_progress/submitted/returned/closed/cancelled | task + task_events |
| 交付验收 | awaiting_review/approved/returned/superseded | review_gate + immutable decisions |
| 正式文件审批 | pending/approved/rejected/conflicted/cancelled | approvals + approval_steps |
| 受控发行 | preparing/ready/released_pending_effective/effective/superseded/withdrawn/cancelled | controlled_releases + effective_pointers |
| 分发证据 | target ack_state + validity_state、reading state、copy withdrawal state | receipts/read events/copy events |

禁止将上述状态压缩到单一 `file.status` 或在一次交付验收后同时自动标记“文控已发行/所有部门已签收”。

## 5. 工作台 UI 合同

- 主导航“工作台”聚合：我的任务、我发起的、待验收、待批准、待发行、部门待签收、个人待阅读、旧版回收异常；统计按权限且不泄漏被限制文件名。
- 文件预览侧栏只显示概览和跳转；完整分发台账在宽画布独立表格展现。
- 布局遵守 `AGENTS.md`：#F2F4F7 冷灰底 + 12px 内嵌白画布，左侧紧凑筛选 / 右侧主表 / 局部滚动；标题不重复导航；RareUI 单套组件。
- 工作列表以可执行任务优先显示，第一屏默认不是流程创建向导。用户点击“查看工作分支”“提交验收”“签收发行”都应明确当前操作的文件版本和权限。
- 签收主表：接收部门、指定接收人、**实际签收人**、发放时刻、**服务器确认时间到秒**、签收状态、已读/应读、旧版回收/异常。行详情有代理资格、清单、签收声明及证据编号。
- 独立用户阅读名单显示岗位、首次查看时间、主动确认时间；**不展示培训率**。
- 时间过滤/排序、人员筛选、空态、长文件名、可调整侧栏、浏览器 820px 窄屏、键盘操作及长表大数据需远端 Chrome 验收。

## 6. 错误、幂等、授权与日志

- 所有修改操作必须使用登录身份、资源 ACL + 业务角色授权、`Idempotency-Key`、`If-Match/expectedRevision`；服务端在数据库事务内复核状态及授权。
- `403` 不具资格，`404` 无权确定资源存在性，`409` CAS/重复活动对象/并发冲突，`422` 业务前置条件、哈希或受控范围校验失败；`503` 基础设施不可用；超时后依据幂等键查询而不直接宣称失败或成功。
- 所有证据以 UTC 存储服务器时刻、请求 ID、行为人、机构角色快照、源/目标的哈希及业务上下文。
- 存储时间的单位与时区按接口约定，界面显示“YYYY-MM-DD HH:mm:ss 北京时间”等明确时区；不要仅展示日期伪称精确签收时间。
- 不允许从 HTTP 请求参数随意决定 `actual_receiver_id`；必须从认证会话中确定操作者，再校验是否拥有接收代理资格。

## 7. 分层规格的实施次序

1. G0 制度原件、文件类别/分发审批职责、电子签收与盖章替代能力核实；**尚未确认的行为不能作为正式制度宣称上线**。
2. G1-A 完成分支保存和读版本解析合同；不改变现行普通非受控文件语义。
3. G1-B 完成任务/整合候选/正式批准的事务和角色合同。
4. G1-C 冻结发行产物、正式发行、分发冻结清单及签收证据合同。
5. G1-D 迁移/兼容/回滚/保留/权限/安全门禁与非业务建模测试。
6. G2–G5 在远端按切片实现并测试，未取得实施授权前停留在 SPEC 阶段。

## 8. 评审发现关闭标准

| 原问题 | 当前 V1.1 状态 | 验收证据所在合同 |
|---|---|---|
| 旧 publish 绕过 | **规格已补齐，代码未整改** | RELEASE、MIGRATION |
| 受控当前版与 latest 混淆 | **规格已补齐，代码未整改** | VERSION、MIGRATION |
| ONLYOFFICE 独立分支 | **规格已补齐，代码未整改** | VERSION、TASK |
| 单 pending 审批与多分支 | **规格已补齐，代码未整改** | TASK、RELEASE |
| 最终签章 Blob 冻结 | **规格已补齐，代码未整改** | RELEASE |
| 资料包清单规范化 | **规格已补齐，代码未整改** | RELEASE |
| 旧证据的保留与删除 | **规格已补齐，代码未整改** | MIGRATION |
| 培训率无制度依据 | **维持排除** | 本文件 §0.1、RELEASE §5 |

**重要**：“规格已补齐”不是“运行系统已具备”；只有具体 DDL、后端、浏览器测试及制度核对全部通过才能解除上线 NO-GO。
