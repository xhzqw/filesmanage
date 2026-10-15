# CDW-MIGRATION-ACCEPTANCE-v1.1 — 兼容迁移、数据保留、远端验收
> **已被测试阶段 G1 Clean Start 决策替代（2026-10-15）**：本文件的历史数据迁移、旧 `released` 分类、签收补录、双轨兼容、历史保留基线等计划**不再执行，也不是开发阻断**。当前有效工程设计请看 `docs/design/CDW-G1-ARCHITECTURE-TRANSACTIONS-API-v1.2.md` 和两份 `CDW-G1-DDL-*.sql`。仅保留关于新生成证据、权限、远端验证、备份/安全操作的原则。绝不因此自动清理任何实际数据库。

> 隶属：`docs/SPEC-CONTROLLED-DOCUMENT-WORKBENCH-v1.1.md`。
> **此处只有迁移与测试设计，不执行 DDL、业务代码修改、push、远端重启或部署。**
> 禁止重写现有未提交文件；历史受控证据不能由迁移脚本伪造。

## 1. 基线代码与模型事实 [L]

| 组件/路径 | 当前行为 | 新版适配原则 |
|---|---|---|
| `migrations/0001_core.sql` | files.current_version_seq、file_versions、approvals；同 file 只一个 pending approval | 旧历史保留，候选稿/审批流程单独扩展 |
| `migrations/0018_approval_chains.sql` | 原 approval chain 限定 1..5 个顺序人 | 新模板 DAG 不复用长度 5 的数组表示任务层级 |
| `migrations/0022_file_lifecycle.sql` / `file_lifecycle.go` | file_lifecycle released/archived、published_seq 等；publish 非新文控发行合同 | 旧语义改为 legacy 元数据/只读兼容摘要；受控发行新系统为权威 |
| `internal/application/approvals.go` | 最终审批追加正式文件版本、改 current_version_seq | 受控有效内容独立指针和访问解析器 |
| `internal/application/office.go` | 文件级 Office session；保存回调 appendVersionTx | 迁移到 work_branches；旧会话在切换期间受控隔离 |
| `internal/application/files.go` / `preview.go` / `print.go` / `indexing.go` | 主要依据 currentSeq(file) 取字节和索引 | 受控与非受控分流，统一 `ResolveContent` |
| `migrations/0031_seals_and_signatures.sql` / `0034_seal_revision_snapshots.sql` | file/version 绑定的图章不可变快照 | 发行物将某次图章修订和结果 Blob 冻结 |
| `migrations/0028_durable_realtime_events.sql` | DB trigger 写持久失效事件、私有事件按人 | 新私有签收/阅读通知应复用持久语义，禁止敏感内容公开广播 |
| `internal/application/trash.go:189–228` | 永久清理保护依赖原有 file_lifecycle 状态/保留期限 | 增加发行/签收/审批/工作交付引用与法定保留门禁 |
| `migrations/0044_review_assignment_workflow.sql` | 现有 file_review_comments 有分配/验收状态及事件 | 迁移时保留历史批注；新任务 gate 不应直接复用为唯一工作流状态 |

**版本漂移声明**：上述定位来自 2026-10-15 本地只读核对，远端是运行唯一事实来源，实际迁移前必须核对本地 HEAD 与远端 HEAD、现行 DDL、业务数据、API 路由和 UI。不得以此声称部署现状已测试。

## 2. 旧数据分类与迁移矩阵

| 历史对象 | 可自动迁移的事实 | 需要人工/文控制度确认 | 禁止自动填造 |
|---|---|---|---|
| 非受控普通文件 | 文件 ID、历史版本、当前最新、ACL | 是否纳入未来受控范围 | 正式批准/签收 |
| 原生命周期 released 文件 | published_seq/time/by 原事实 + `legacy_provenance` | 是否视为当前受控执行依据、适用部门与范围 | 新式发行/已生效/已签收全链 |
| 有旧审批通过记录的版本 | `approval_id`、actor、source sha/时间 | 是否满足现行有效文控审签要求 | 新发行的 scope approval/收件凭证 |
| 旧签章 PDF | 原图章修订、文件哈希、修订时间 | 何种章符合受控制度及留存 | 电子发行章等效结论 |
| 旧归档/作废状态 | 归档时间、原生命周期保留 | 对应受控制度下的作废/保留范围 | 旧版回收人/数量/完成时间 |
| 已存在工作批注 | 原评论/指派/解决/审批事件 | 与通用任务节点的对应关系 | 未实际发生的父子任务和责任履行 |
| 旧文件夹结构 | 文件 ID、历史路径能取到的事实 | 冻结范围的时点 | 以今天目录成员伪造历史固定清单 |

建议引入独立 `legacy_controlled_baselines`：`file_id,legacy_published_seq,legacy_lifecycle_state,source_record_id,source_validated_by,validated_at,migration_status,warning_notes`。**它不是 department_receipts，也不是 controlled_releases 的正式发行事实**；作为过渡执行版展示前，必须有有权文控人员明确签认适用版本与继续使用依据，UI 显示“旧体系基线/证据尚未电子化”。

### 2.1 迁移原则

1. 所有新增表使用前向兼容 migration；旧数据不覆盖，原权限机制保持运行；新增的受控发布入口不得仅靠前端隐藏旧按钮。
2. 建立 `controlled_document_profiles` 时默认 `unmanaged`，逐份文件或经批准分类规则纳入 `managed`；从 unmanaged 切换 managed 必须核验合法当前有效基线策略。
3. 对已有 released 文件，先分类为 `legacy_unverified / legacy_validated`；未验证前不生成“新受控发行成功”事件。
4. 真正的 `current_effective_release_id` 只可能来自已经通过新流程的合法发行；旧基线使用独立明确的 legacy resolver 分支，不混在新发行表里。
5. 迁移后新产生的受控发行必须按照新版完整守卫；不得继续调用旧 `publish` 绕过审批/文控确认。
6. 可回退功能开关，但已产生的新正式发行和签收证据不可因回退而删除；必须保留只读审计通道。

## 3. 读路径与兼容切流（P0-B）

### 3.1 分流真值表

| 文件类别 | 当前执行版 | 默认预览/下载/打印/索引 |
|---|---|---|
| unmanaged 普通文件 | 不适用 | 兼容原 current_version_seq |
| managed + 有 effective_pointer | 确定 release | 返回该发行的冻结主 artifact，按目的与授权过滤 |
| managed + legacy_validated、未新发行 | 旧体系确认基线 | 返回显式确认的 legacy snapshot 并标注身份，不伪造新 release |
| managed + no effective + no valid legacy | 无 | `no_effective_release`，不得回退 latest |
| managed + 仅有 approved_candidate | 未生效 | 默认仍返回合法旧基线；候选仅在审核上下文可见 |
| managed + withdrawn without authorized substitute | 无合法执行版 | 阻断普通执行访问，历史单独授权查看 |

### 3.2 实施选择原则

- 将 `ResolveContent` 作为所有文件内容入口的唯一依赖：preview/media、download/Range、print/prepare + render、PDF/Office 分页、转格式、签章导出、搜索/摘要、共享链接、受控读者和 Office source。
- 二次请求必须携带受控内容上下文（如安全的 artifact id / nonce / expected sha）并再验权限，避免 prepare A/1 后 render A/2 的 TOCTOU。
- 全文检索必须防止未生效已批准文字进入普通人搜索结果；工作分支索引单独按任务权限。
- 现有 `files.current_version_seq` 保持历史兼容含义，不把它直接解释成 controlled effective pointer。
- 受控访问走最小 `release_access_grants`，不修改源目录 ACL；授权失效使 Range/预览/打印和页面缓存失效。
- 上线前必须完成“真实所有引用 currentSeq/read current currentVersion”全仓库清单，不局限于本文件所列入口。

## 4. 删除、GC、备份与证据

### 4.1 保留语义

正式证据至少涉及：`approved_candidate Blob`、`release_artifacts`、`department_receipts`、`reading_events`、`controlled_copies`、`withdrawal_events`、`activation_decisions`、`task_deliveries` 和审计/模板快照。必须依据经确认的保存策略与引用关系禁止危险永久清理。

- 工作区软删除可允许业务状态为 `not_visible_in_explorer`，但受控发行证据与审计历史不能随目录删除而级联消失。
- 永久删除受控源文件或文件夹子树时，逐项检查有效发行/保留/争议/历史证据引用；不满足条件则拒绝或采用明确归档隔离流程。
- `blobs.gc_pending` 与引用保留必须在数据库内原子协商，GC worker 在删除前二次确认引用、保留截止与保护期。
- PDF 梳理第 5 页涉及作废原件和记录保存要求 [P]，但其具体适用范围/版本仍待原件核对 [V]。禁止随意统一设置 30/90/365/730 天取代现行受控期限。
- 数据库备份与 Blob 备份必须保证同一恢复点一致；恢复测试断言能重新计算发行物、签收证据和 manifest 的校验哈希。对用户可见的审计空洞要报警，不以普通 file_not_found 替代。

### 4.2 实时事件与权限

原有 `realtime_events` 有匿名失效和按 user 私有事件。发行/签收/阅读新业务按 event-sourcing-lite：业务事实在自身表/事件表持久化，通知 outbox 同事务；实时层只发变化作用域/匿名提示，不广播文档标题、具体部门或人员敏感信息。断线重连按 cursor 重新抓列表并重新鉴权，过期 cursor 全量重取。

用户离职/调岗/授权撤销/签章权变化，实时事件之外还须服务端版本访问与签收操作即时生效；不依赖浏览器收到 WebSocket 作为安全条件。

## 5. 不可跳过的迁移序列（计划，非执行记录）

| 阶段 | 目的 | 退出门禁 |
|---|---|---|
| M0 | 制度原件确认、文件分类、关键角色/章/电子签收规则决定、基线盘点 | 有文控/质量签审和历史数据清单 |
| M1 | 新表 schema 和读路径 `ResolveContent` 可用，但 controlled 开关关闭 | 非受控业务全回归、历史数据无损 |
| M2 | Office 分支与任务交付分离，保留原普通文件编辑兼容 | 两分支并发保存、无误写正式版本 |
| M3 | 新批准候选与受控发行路径、发行物冻结及有效指针 | P0 发行/权限/原子性测试全部通过 |
| M4 | 部门分发、签收、阅读、纸质回收、调度 | 时间/人/版本/回收/异常可追溯 |
| M5 | 为确认纳管的文件切换旧 publish 行为、引导到工作台 | 新旧入口不能给出矛盾的“已发布” |
| M6 | 远端多用户 E2E、异常/重启/备份恢复、报表及回滚预案 | 全部强制门禁通过再扩大覆盖 |

- 双写不是双权威。迁移窗口内旧 legacy 状态可以是兼容**只读投影**，但新受控文件的正式发行事实必须以 `controlled_releases` 和审计为权威。
- 发布新 feature flag 时先做影子读对比，仅记录合法非敏感差异；不能让试验切流的异常值替换正式执行版。
- 新表只有当所有新约束和读写服务完成后才允许纳管任何正式文件；关闭开关保留新证据只读，不执行数据逆迁移“回滚”。
- 本仓库 AGENTS.md 明确远端才允许构建/运行/验收；本轮仅写规格，不执行运行/测试/部署，不能宣称已通过。

## 6. 扩展验收用例 CDW-25–CDW-48

| ID | 用例 | 必须断言 |
|---|---|---|
| CDW-25 | A/2 已批准未生效，A/1 当前有效 | 默认预览只读 A/1；有权审核入口可读 A/2 |
| CDW-26 | 用户直接调用下载 URL | 不能绕过受控当前版本/授权 |
| CDW-27 | 打印 prepare/render 中版次切换 | 渲染必须对应已准备哈希或失败 |
| CDW-28 | 旧 publish 调用已纳管文件 | 明确拒绝，不得形成合法受控发行 |
| CDW-29 | 文控自行加入未获批准的接收部门 | 签发/发放拒绝，记录权限事件 |
| CDW-30 | DOCX 源批准→PDF 转换→章修订→发行 | 全链数据来源及 hash 可复算 |
| CDW-31 | 发行后 PDF 图章修订变更 | 历史发行物哈希和内容不变 |
| CDW-32 | A/2 已签收，A/3 已生效 | A/2 acknowledged+superseded 共存 |
| CDW-33 | 20 文件资料包中一份撤回 | 旧清单历史不改；重新分发或授权例外 |
| CDW-34 | 删除仍被签收记录引用的文件 | 证据/Blob 不受永久清理破坏 |
| CDW-35 | 老 released 无新式审批证据 | 迁移显示 legacy，不能凭空“已批准已签收” |
| CDW-36 | 收件人无源研发目录权限 | 可按发行 ACL 读指定 artifact，不可读目录草稿 |
| CDW-37 | 调度器停机跨过 planned_effective_at 后恢复 | 幂等补偿；不会重复激活 |
| CDW-38 | 同发行的撤回与激活并发 | 最终只有一种合法状态，审计一致 |
| CDW-39 | B/C 独立 Office 分支同时保存 | 两 Blob/修订独立、正式 current_seq 不变 |
| CDW-40 | 阅读名单后来增加/取消人员 | 历史 as_of 统计按原 roster 再现 |
| CDW-41 | 通知已送达但无主动签收 | ack_state 仍 pending |
| CDW-42 | 预览/下载/打印同一受控发行 | 全部同 artifact hash 或严格授权失败 |
| CDW-43 | 代理签收者资格过期 | 不生成有效 receipt，历史有效签收保留 |
| CDW-44 | 同一批次重复递交签收请求 | 只产生一份有效凭证（幂等） |
| CDW-45 | 电子发行，没有纸质副本 | 报表纸质数量不伪填，回收为不适用 |
| CDW-46 | 普通用户查找未生效候选内容 | 搜索摘要/分页/分享链接不泄漏 |
| CDW-47 | 新版撤回且无合法可用替代 | no_effective_release，不回退未经授权旧版 |
| CDW-48 | 无培训程序、默认工作台报表 | 无培训率、无培训必做、无培训生效阻断 |

## 7. 跨系统强制测试矩阵

| 类别 | 最少验收内容 |
|---|---|
| 模型 | 唯一有效 pointer、清单冻结、同版本不同分发批次、同一部门签收状态正交 |
| 并发 | 激活 vs 撤回、签收双击、改派 vs 签收、Office callback vs 交付冻结、删除 vs 保留、依赖图成环 |
| 越权 | 技术管理员冒充文控、审批人冒充接收人、部外用户读取人员列表、权限撤销后通过旧 token 获取页面或 Range |
| 可靠性 | 断线恢复、worker 重试、DB rollback 不发通知、事件 cursor 断层重建、预检通过后权限变化 |
| 版本 | 最新历史 vs 当前有效、DOCX/PDF lineage、图章修订固定、工作分支与正式版隔离 |
| 报表 | QP-01-JL02 栏位对应真实事件、0 分母显示不适用、时间到秒、纸质数量、旧版异常 |
| UI | 桌面/笔记本/窄工作区、最常用待办首屏可见、左筛右表、键盘/拖拽上传不回退、无重复动作 |
| 恢复 | 备份一致、Blob 哈希复核、迁移回滚保留只读证据、新旧发布入口状态一致 |

## 8. GO/NO-GO 与交付证明

- G0：制度原件、分发范围确定人及数量、盖章/电子签收合法性、受控保存期已核对。
- G1：字段级 DDL 预审、业务状态机、事务锁、授权矩阵、OpenAPI 请求/响应/错误模式与双模式读取范围冻结。
- G2：远端 Go 测试 + PostgreSQL 真实事务/并发/迁移检查（不得用纯内存测试代替）。
- G3：远端 Chrome 上真实 ONLYOFFICE 协作、断线重连、签收/打印/搜索/预览与回收场景。
- G4：旧数据审计、导出证据、保留/恢复、回滚开关、防重复签收与越级责任链。
- G5：实施结果报告记录实际远端 HEAD、migration 版本、环境、截图和测试输出；只在用户授权后启用。

**现阶段只有设计文档，无数据库迁移执行、无业务代码修改、无部署验收。**
