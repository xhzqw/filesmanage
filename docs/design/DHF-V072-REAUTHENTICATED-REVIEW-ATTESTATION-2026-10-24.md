# DHF V0.7.2 — 冻结审核决定的密码再认证与独立签审确认凭证

> Document ID: DHF-ENG-REVIEW-ATTESTATION-20261024-01  
> Date: 2026-10-24 · Version: V0.7.2 engineering draft  
> Status: **PILOT / Not qualified legal electronic signature / NO production release**  
> Branch: `feat/dhf-v06-gate-pilot` · PR #1  
> Engineering constraints: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`, `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`, original nine-stage XMind.

## 1. 依据和精确边界

已确认业务政策：“默认逐级回签；允许经授权越级介入但不自动免除中间责任”。V0.7.1 已在 G5 按已发布模板形成不可变专业审核顺序，G6 首次转移独立总 Gate；`dhf_pilot_review_decisions` 记录不可变的**建议通过/建议退回**，而不具备独立身份签署。项目所使用的 `seals` 模块是文件版本绑定的可视化印章/签名标记，不等于 DHF 阶段的电子签审。

V0.7.2 新增“有当前账号密码再认证的审核确认凭证”。执行者必须明确确认**原审核决定、原提交、冻结 policy/manifest SHA-256 和意见内容**，不能以文件当前版本、管理员标志、Gate 介入许可或别人的任务自动代签。

**合规边界：** 该记录是具有身份再验证和审计关联的系统证据；**不是**独立密码学签名、可信时间戳服务提供的不可抵赖签名、法律认证电子签名、已经企业授权发布的最终 Stage Gate 接受或受控文件发行。正式签名体系和批准职责仍需单独验收。

## 2. 数据模型

新增 `migrations/0052_dhf_pilot_reauthenticated_review_attestations.sql`：

- `dhf_pilot_review_attestations`：冻结任务 ID、审核决定 ID、原提交 ID、再认证签署人、原建议结论、签署意图、policy SHA、manifest SHA、内容摘要、操作幂等键、请求哈希、认证方法和时间。每个审核任务和审核决定**至多一份**身份确认记录；同一签署人的幂等键唯一。
- `content_sha` 由后端根据完整原审核决定的不可变字段按确定性结构摘要计算，涵盖 `decisionId/submissionId/taskId/reviewerId/outcome/comment/policySha/manifestSha`，不允许客户端提交签名内容哈希。
- SQL 触发器重新核对该任务确实分配给该人、当前账户活动/无需强制改密、项目/模板/基线活动、冻结的双哈希与来源一致，且其建议结论的任务状态已达到 `reviewed` 或 `returned`。
- **前序身份确认签署顺序**由数据库强制：普通专业必须等前序专业已形成经密码认证的通过确认；获授权提前介入的后续专业可以在前序签署前完成本人确认，但原前序责任继续存在。总 Gate 的“建议通过”确认，无论何种提前介入，都必须等待全部前序通过确认实际写入。
- 延迟约束：签审确认记录必须与原审核任务相符的 `audit_events` **同事务提交**；无审计插入不可提交。任何已签审确认记录不能 UPDATE/DELETE。

## 3. 身份认证与应用事务

`DHFPilotAttestReview` 在 SERIALIZABLE 事务中执行：

1. 从真实会话取得操作人，锁定本人、本人已经决议的审核任务；禁止客户端指定他人的签署人。
2. 检查仍是活动账号、没有强制改密；通过 `UserByID` 和 `UserByLogin` 交叉确认账号身份。
3. 同一事务重新使用现有 `bcrypt.CompareHashAndPassword` 验证当前账号口令。**密码、bcrypt hash、失败密码内容均不写入签审表或审计 details。**
4. 同一账号 15 分钟内已经有五次密码再认证失败时拒绝进一步尝试；密码错误记录仅保存不含秘密的拒绝事件。
5. 验证精确固定声明 `I confirm this DHF review opinion and its fixed evidence identity`；声明、来源决定 ID、操作人、冻结摘要和幂等键必须与本次请求一致。
6. 先核验本人已存在确认记录（仅完全一致时允许重放）、否则一次性插入签审凭证和审计。任何前序责任/账号/证据冲突都使事务完整回滚。
7. **绝不**修改 `dhf_pilot_attempts.state` 为 `accepted`，也不让确认凭证隐式触发 CDW 文件发行或部门签收。

## 4. 统一工作台

在既有 `/approvals` 工作台内增加“签审身份确认”：

- `GET /api/workbench/dhf/attestations` 返回原审核人自己的决议及冻结来源摘要、前序已确认状态，不能看到其他审核人的私有签审任务。
- `POST /api/workbench/dhf/tasks/{id}/attest` 要求精确 decision ID、登录密码、固定签署意图和唯一幂等键；OpenAPI 将密码定义为 `writeOnly`。
- 审核人查看自己历史意见、完整来源摘要，勾选签署声明并输入密码完成单次身份再认证。密码在 UI 完成/失败后清空；不会在 URL、浏览器预览链接或响应中返回。
- 原“研发阶段审核”“我的研发整改”及 PDF/DOCX 冻结文件审阅继续独立显示；没有新建第二个审批中心。

## 5. 研发验收项

| 检验 | 预期 |
|---|---|
| PostgreSQL 全新隔离库迁移 | 54/54 |
| 非审核人代签 / 管理员代签 | 拒绝 |
| 错误密码与暴力试探 | 仅审计非敏感拒绝，五次/15 分钟后限流 |
| 原推荐已通过但前序密码确认未完成，总 Gate 提交本人签审 | 拒绝 |
| 后续专业有 Gate 授权提前介入 | 允许本人密码再认证，但前序责任不消除 |
| 前序专业签审后，总 Gate 才可确认 | 允许 |
| 完全相同幂等键重试与不同内容重试 | 复用原记录 / 拒绝重复 |
| 无同事务审计记录的直接 SQL 插入、UPDATE/DELETE | 拒绝 |
| G5/G6 原提交、整改、PDF/DOCX 固定版本、原 ACL 测试 | 继续通过 |
| 全套 Go/Vet、Go 服务构建、Vite、OpenAPI 契约 | 实际退出码验证 |
| 浏览器真实大小交互、正式电子签署法规/业务 SOP 验收 | **未执行，不得标记 PASS** |

## 6. NO-GO 和下一步

企业有效签署仍需要正式授权的 SOP、可独立校验的签署凭证与密钥保护、可信签名时间及相应凭证撤销/寿命策略；之后在唯一 Gate finalization 事务中实现归口审批、整改复验正式关闭、责任回签、签署覆盖范围检查、CAS/outbox，以及与 CDW 文件受控发行状态机的明确边界。物理 Blob 留存/灾难恢复、安全/并发和真实浏览器验收同样是生产门禁。

**NO-GO**：本阶段只建立密码再认证的可追溯审核确认记录。企业正式 Gate 决定、条件放行、文件分发、部门签收均未被此阶段自动启用。
