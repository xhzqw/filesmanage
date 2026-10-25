# DHF V0.7.0 — 阶段退回、受控整改与独立重新提交链路

> Document ID: DHF-ENG-REMEDIATION-20261024-01  
> Date: 2026-10-24 · Version: V0.7.0 draft  
> Status: **DEV branch implementation / NOT an approved corporate DHF procedure**  
> Branch: `feat/dhf-v06-gate-pilot`, PR #1  
> Governance: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`, `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`.  
> Primary source: original nine-stage XMind text digest `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`.

## 1. 现状与原则

V0.6.7 已可以不可变事件记录 G5 专业和 G6 总 Gate 的“建议退回”，但原提交人在统一工作台里还没有受控整改工作区，且无法证明新批次与旧意见的出处和证据差异。V0.7.0 引入**来源意见、原提交、整改案例、新尝试、新证据 Manifest**的固定关联：

1. **从一条真实、不可变且已经写入数据库的 `recommend_return` 复核意见开始**；未退回、仍待审或伪造的决定 ID 一律不得立案。
2. 仅原项目原提交责任人、且仍具备 `can_prepare`、活动项目和有效账号时可发起；普通审核人、其他成员及客户端自称的管理员不获得隐式越权。
3. **原 `submission_id`、原 `attempt_id`、原 `manifest_sha`、原审批任务和原决定永久不改写**。纠正来自新的 Attempt ID，与原模板及阶段保持一致；G6 首次转移不得被 G8 后续转移替代。
4. 原 1:1 要求身份必须完整保留；要求数量、名称和有效文件元组不能被错误减少或加入假项目。至少有一个受控文件版本或要求记录真正发生变化，单纯 JSON 排序变化不算整改。
5. 新 Manifest 在提交**不可变案例之前**经过真实项目授权、来源版本、原文件 `download` ACL、完整要求集和现有 Gate `ActionPrepare` 校验；错误 SHA、虚构版本或其他无法准备的证据使事务完整回滚。
6. **同一个原始提交最多一个整改分支**，但所有专业的原退回意见仍能通过 `original_submission_id` 关联查询。任何后续退回需要由其新提交建立下一轮案例；不能覆盖原历史。
7. 同一退回意见、原责任人、整改计划、原/新摘要、幂等键重复调用返回原案例和原 Attempt，不能生成双份整改。
8. 改正后需使用原提交规则进入**新的** `submitted`，生成自己独立的冻结证据和审核任务；不复用旧的通过建议或退回意见。不将任何旧提交或当前 Stage 直接改为 `accepted`。

## 2. 数据模型及事务

- `0050_dhf_pilot_return_remediation_journal.sql` 新增 `dhf_pilot_remediation_cases`、`dhf_pilot_remediation_events`，含案例唯一身份、原退回 Decision、旧 Submission、新 Attempt、阶段/项目/模板、原/新 SHA、整改计划、来源用户、幂等键、事件时间与请求哈希。
- PostgreSQL 触发器交叉验证 `return_decision_id`、`original_submission_id`、`new_attempt_id` 的真实项目/阶段/模板关系，且事件与案例必须**同事务提交**；来源和事件禁止 UPDATE/DELETE。
- 对已关联整改案例的新 Attempt，即使状态还在 `preparing`，也禁止通过数据库更改 `manifest_body/manifest_sha`、项目、阶段、模板或原责任人，防止案例哈希与事实脱钩。
- `DHFPilotOpenRemediation` 使用 SERIALIZABLE 事务，锁定真实退回意见，权限与内容核验、插入新 Attempt、插入案例、追加 opened 事件与 `audit_events`、准备阶段 Gate 预检、Commit 构成原子操作；错误后整笔回滚。
- 立案不意味着已修复、已关闭或已获批。**本版没有“整改关闭”写路径**，不会仅因新批次提交成功就判定责任闭环完成。

## 3. 工作台 API 与界面

- `GET /api/workbench/dhf/returns`：原提交人仅查看属于自己提交的退回记录、来源 Manifest 和关联新 Attempt，最多 100 条；不授予原文件新的访问权限。
- `POST /api/workbench/dhf/returns/{id}/remediation`：请求包含完整新 Manifest、10–2000 字符整改计划和幂等键；返回旧 Submission ID、新 Attempt ID、整改案例 ID 和 `trialOnly` 标志。
- 统一 `/approvals` 工作台新增“我的研发整改”视图，避免第二个任务中心。
- 原责任人可查看退回理由、原证据版本，按当前真实文件元数据选择更高的受控版本并写入修改说明，再创建整改案例；前端不自动选择最新版，不要求用户编辑裸 JSON。
- 没有后续有效版本/无文件查看授权时不可直接选择；服务端在写入前仍重新验证下载权限和真实文件版本。
- 旧文件修改审批、CDW 在线编辑和受控签收继续保留，不移除原有历史链。

## 4. 安全矩阵与真实远端验收

执行边界：`root@10.144.144.1` 的独立 Git 检出、一次性 PostgreSQL 17 测试数据库、临时 BlobStore；**没有正式生产服务变更**。全量前端打包已通过，但仍存在原工程 Three.js 打包体积提示，属于非阻断性能优化项。

| 用例 | 预期行为 | 实际状态 |
|---|---|---|
| 新 `0050` 从空库迁移并检查 | 52 项 SQL 迁移全部成功 | **PASS** |
| G6 reviewer 发起本人之外的整改 | 必须拒绝 | **PASS** |
| 未退回的 G5 通过建议被用作整改来源 | 必须拒绝 | **PASS** |
| 没有真正变更要求 / 仅重复 Manifest | 必须拒绝 | **PASS** |
| 虚构 file version 999 / 错误 SHA | 整笔回滚，不抢占唯一案例 | **PASS** |
| 原提交人有效立案 | 1 case + 1 opened event + 1 audit + 1 new preparing attempt | **PASS** |
| 同幂等键精确重放 / 改动请求 | 重放同案例 / 冲突不改历史 | **PASS** |
| 退回记录只能由原提交人读，不能由审核人读 | 原责任人看到真实原因与新批次；他人不可见 | **PASS** |
| 手动改写已链接新 Attempt 的 Manifest/SHA | 数据库直接拒绝 | **PASS** |
| 新 Attempt 正常提交 | 新冻结 Submission 和新 G6 专属审核任务；旧提交仍 submitted | **PASS** |
| 上阶段 G5 PDF/DOCX 冻结页图与文件 ACL 负例 | 不回退 | **PASS** |
| API 生成器、验收矩阵、Go 完整测试、Vet、Vite | 实际退出码为 0 | **PASS**：代码提交 `017a1676`，OpenAPI 133 paths，验收矩阵 126 ids，完整 Go、Vet、3 个 Go 命令构建及 Vite 构建均退出 0 |
| 浏览器三尺寸人工验收、正式签章 | 必须独立完成 | **NOT_RUN / BLOCKED** |

## 5. 仍为 P0 的正式签审与整改关闭

1. **审核人责任链**：流程模板签署人顺序、受权越级介入事件与仍未豁免的中间责任，必须有独立持久化责任义务、决议日志和身份签署凭证。现有 `recommend_pass` 仅是试点意见。
2. **整改关闭与复验**：由有权专业审核人员针对新 `submission_id` 的具体固定版本逐项复验，追加签署事件，并由正式 Gate 事务确认；绝不可把“立案”“提交”自动当作结案。
3. **受控文档发行**：DHF 阶段验收与 CDW 文件发布、部门签收、阅读确认及培训仍属于不同受控状态机。
4. **正式模板发布**：G5 各专业的必交判断、原始 XMind 节点分类、G6/G8 依赖均不能从示例目录直接假定已经批准。
5. **内容留存与审计**：物理 Blob 保留、备份恢复、离线丢失检测、LAN 并发/灾难恢复和真正的用户权限验收。

**NO-GO：**阶段接受、法律意义电子签署、条件放行、文件受控发行均未由 V0.7.0 开通。
