# DHF V0.7.3 — 原退回责任人对整改版本的独立复验及结案凭证

> Document ID: DHF-ENG-REVERIFICATION-20261024-01  
> Date: 2026-10-24 · Version: V0.7.3 engineering draft  
> Status: **PILOT / NO official Stage Gate acceptance or legal qualified e-signature**  
> PR: [xhzqw/filesmanage #1](https://github.com/xhzqw/filesmanage/pull/1)  
> Baseline: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`, `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`; original nine-stage XMind governs terminology.

## 1. 来源、已确认决议与实现边界

用户已确定“默认逐级回签，允许授权越级介入，但不免除中间责任”。原 XMind 是 DHF 九阶段来源：G5 输出评审、G6 第一次设计开发转移和 G8 后续转移彼此独立，不应合并。V0.7.0 已有原“建议退回”不可变结论、整改记录、新独立准备 Attempt 和重新提交；V0.7.1 建立阶段逐级责任链；V0.7.2 增加已决定的审核意见与本人当前密码再次认证后的不可变确认。

**本版只处理一个新的、独立的审计事实：原退回审核人对整改后冻结证据确实完成复验。** “复验记录存在”不同于整改对应的法律意义电子签章、整个阶段的公司批准、受控发行或部门签收。不存在“结案就 automatically accepted”或把旧 Gate 意见自动提升为正式签名的路径。

## 2. 修订链路

`Original review_decision(recommend_return)` → `original_return_attestation` → `remediation_case` → `new_attempt` → `revised_submission` → `all revised review_decisions(recommend_pass)` → `all revised review_attestations` → `remediation_verification`.

1. 只能由**原退回意见的原审核人**发起复验，不授权原提交人、其他专业人员或仅有管理员身份的人代签。
2. 原退回决定必须有该审核人的独立密码再认证确认记录，且结论确实为退回。
3. 新提交必须来自这个整改案例唯一关联的 `new_attempt_id`，项目、阶段、模板、原提交人、Manifest SHA、Policy SHA 必须真实一致。
4. 修订后阶段必须有完整专业与 Gate 责任链；**每一项新审核任务**须为 `reviewed`，有 `recommend_pass` 意见，并有对应本人再认证的 `recommend_pass` 确认。任何待审、退回、漏签均拒绝复验。
5. **重新核实物理证据**：同一事务读取原提交和新提交的所有冻结 `file_id/version_seq/blob_id/sha256`，按原退回审核人当前的 `ActionPreview` ACL 校验，并实际检查 Blob 存储内容长度和 SHA-256。原文件或整改文件被删除、无权预览、版本号串用或物理字节被篡改，都禁止复验。
6. 原审核人再次输入当前密码、明确确认复验意图，并填写 10–2000 字复验依据。密码绝不储存。账户禁用、需强制更改密码或过去 15 分钟五次失败均拒绝；失败认证只记录不含密码的拒绝审计。
7. `SERIALIZABLE` 事务中，唯一复验 ID、原退回确认 ID、修订提交 ID、原/修订 Manifest SHA、修订 Policy SHA、本人 ID、原因、幂等键和请求 SHA 一起保存，追加同事务 `audit_events`。案例只能验证一次，完全同请求返回原结果，不允许改写结论。
8. 不改变原/新 `dhf_pilot_attempts.state` 或任何 CDW 文件分发/签章状态；复验记录属于试点工程证明。

## 3. 交付的 SQL / API / UI

- `migrations/0053_dhf_pilot_remediation_reverification.sql`：新增 `dhf_pilot_remediation_verifications`；案例和修订 Submission 一对一约束、不可变触发器、来源身份验证、全部受控审查确认检查、同事务审计延迟检查。
- `internal/application/dhf_pilot_remediation_verification.go`：源退回人身份、密码、任务摘要、原/修订文件访问、真实 Blob 数据、同一事务插入及幂等回放。
- `internal/adapter/postgres/dhf_pilot_remediation_verification.go`：从原意见与新修订提交读取事务一致的证据关系；生成不可变复验与审计行。
- `GET /api/workbench/dhf/verifications`：只返回本人作为原退回审核人的整改复验队列、准备状态、原退回原因及新提交摘要。其他项目用户和原提交人不能从审核人队列偷看。
- `POST /api/workbench/dhf/remediations/{id}/verify`：请求复验理由、当前本人密码、确认声明与幂等键；不接受客户端指定审核人、阶段状态、签名时间或 SHA。密码在 OpenAPI 中标记 `writeOnly`。
- 统一 `/approvals` 工作台新增“整改复验”选项，提供原退回/整改依据、旧/新冻结摘要、新提交、密码核验及确认操作；“我的研发整改”对原提交人显示已复验状态。继续复用 RareUI，不增加第二套任务中心。

## 4. 实际隔离测试

测试环境：`root@10.144.144.1`，独立 Git 检出，PostgreSQL 17 仅用于测试的 `filesmanage_dhf_v063_integration_20261024` 和临时 BlobStore。

| 真实检验 | 结果 |
|---|---|
| 从空库执行仓库迁移 | **PASS：55/55**，包含 V0.7.3 的 0053 |
| 原退回审核人还没确认最初退回 | **PASS：禁止复验** |
| 新修订已提交但还未审核或未签审确认 | **PASS：禁止复验** |
| 原提交人代替原审核人复验 | **PASS：拒绝** |
| 原审核人全部条件满足并再次密码认证 | **PASS：生成独立复验和审计事实** |
| 完全相同的幂等键重放 / 改动请求重写 | **PASS：只返回原记录 / 拒绝重写** |
| 直接 SQL 绕开事件审计写入假复验 | **PASS：拒绝** |
| 原/修订文件预览权限不完整 | **PASS：拒绝** |
| 原始冻结文件的真实存储字节被篡改 | **PASS：拒绝并回滚** |
| 复验记录 UPDATE / DELETE | **PASS：拒绝** |
| 复验后新 Stage Attempt 状态 | **PASS：仍为 submitted，无隐式正式批准** |
| G5/G6 原始评审责任、退回整改、PDF/DOCX 固定页图回归 | **PASS** |
| `go test ./internal/... -count=1`、`go vet ./internal/...`、server/worker/migrate 构建 | **PASS**，退出码 0 |
| TypeScript + Vite 生产构建 | **PASS**，保留原有 Three.js 动态导入/大块体积优化警告 |
| `python3 scripts/gen_openapi.py --check` | **PASS：139 paths / 168 operations** |
| `python3 scripts/gen_acceptance_matrix.py --check` | **PASS：126 ids（123 PASS / 3 PARTIAL）** |
| `cmd/migrate -check` 从测试库校验所有迁移 checksum | **PASS：55/55** |
| 浏览器宽屏、笔记本、窄内容区人工验收 | **NOT_RUN** |
| 公司授权的电子签名凭证、私钥、可信时间与 Stage Gate 受控发行 | **NOT_RUN / NO-GO** |

## 5. 下一步与生产门禁

1. 企业签署身份凭证生命周期、授权 SOP、独立验签、可信时间及责任链认证政策需要正式批准，V0.7.2 密码再认证不是合规的可验证数字签名。
2. 采用单独的正式 Gate finalization CAS 事务与 outbox，必须验证已发布企业模板、全阶段适用要求、必要的专业和总 Gate 审核及签名凭证，所有整改独立复验关闭，才能生成不可变批准事件；失败时没有任何阶段状态或外部通知的部分提交。
3. CDW 文件受控发行、部门签收、培训与阅读确认另走本身状态机；G6/G8 严格分开。
4. 再进行恢复、物理 Blob 保留、真实浏览器交互与局域网并发安全验收。没有获得这些验证之前不得在生产服务开启正式审批按钮。

**NO-GO：V0.7.3 交付的是试点整改复验凭证，不是公司的正式签审制度或阶段批准。**
