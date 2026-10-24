# DHF V0.7.4 — 数字签名的 Gate 批准候选、原子审计与 outbox（试点）

> document_id: DHF-ENG-GATE-CANDIDATE-20261024-01  
> version: v0.7.4-draft · date: 2026-10-24  
> status: **draft — engineering pilot; NO formal corporate Stage Gate acceptance**  
> scope: G5 设计开发输出阶段 / G6 第一次设计开发转移；G8 第二次转移不受本版覆盖  
> ownership: 项目维护者 / 产品设计责任人（正式授权人待企业发布）  
> source: 原 DHF 九阶段 XMind、`docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`、`docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`、先前 V0.7.0–V0.7.3 受控工程记录  
> approval: **NOT_APPROVED**，无可接受的企业签署 SOP/受信任密钥颁发记录，禁止生产签署和最终 Gate 状态迁移

## 1. 确定事实和不能推断的制度条件

已确认用户决议：“默认逐级回签，允许授权越级介入，但不自动免除中间责任”。现有 V0.7.1 在 G5 将专业责任顺序从已发布模板冻结、G6 总 Gate 独立；V0.7.2 本人登录密码再认证是个人签审确认，并非独立数字签名；V0.7.3 原退回审核人再次确认修订证据，物理文件/ACL 和冻结摘要必检。**企业受控模板的批准与法律意义电子签名政策尚未提供**。

现有 `dhf_pilot_stage_positions` 数据库约束明确禁止 `accepted/conditionally_released`，不能通过随意修改 CHECK 或复用 PDF 视觉签章绕过。V0.7.4 为减少日后最终批准风险，先交付 **只有外部提供可信公钥并具备对应私钥签名，才能生成独立的试点 Gate 候选事务**。任何成功结果都维持 `trialOnly:true`，**Stage Attempt 仍为 submitted，Stage Position 仍无 accepted**。

## 2. 安全模型与签名载荷

- **职责身份**：必须是真实受控 G5/G6 冻结提交的 `__gate__` 指派审核人，账号仍有效，已形成 `recommend_pass`、该决定已有 V0.7.2 本人密码再认证确认；不能用客户端的管理员标志、提交人角色或其他专业角色代签。
- **整个责任链**：SQL 必须核实此提交的每个专业及最终 Gate 都有不可变的 `recommend_pass` 决定、对应同一冻结 `policy_sha` 和 `manifest_sha` 的本人认证签审确认；不得仅有“全部审核任务完成”。
- **整改责任**：同项目、同阶段任何尚未完成独立复验的整改案例，都不能生成 Gate 候选。若本批提交来自整改 Attempt，还必须和同一案件的已复验 Submission 身份严格一致。
- **冻结物理证据**：签署人当前有效 `ActionPreview` ACL、固定的 `file_id/version_seq/blob_id/sha256`、Blob ready 状态、实际磁盘字节长度及 SHA-256 均需在事务中逐一重新检验；不能以当前 Finder 的最新版替换快照。
- **密码重新核验**：每次实际生成候选时，当前账号用 bcrypt 再认证，沿用过去 15 分钟 5 次失败拒绝的不可变审计机制；不会存储或返回明文密码及散列。
- **数字签名**：外部预置只读公钥环境项 `DHF_PILOT_GATE_TRUSTED_PUBKEY_B64`，为空或格式错误即阻断；不把公钥或私钥从客户端角色声明中取信。私钥**不存入数据库、代码或环境变量**，须由企业另行决定受控保管方式。本版使用 Ed25519 签署领域分离的确定性 JSON payload（domain= `DHF-PILOT-GATE-CANDIDATE-V1`，verdict= `trial_candidate`，及 submission/attempt/project/stage/template/gateAttestation/signer/policySHA/manifestSHA）。验证签名后写入该 payload 的 SHA-256、信任公钥 SHA-256、**公钥原始字节（非私钥）**及 64-byte 签名，方便历史独立验签。数字签名有效**不等于**密钥持有人合法企业授权。
- **并发与一次性**：所有写入走数据库 SERIALIZABLE 事务；`submission_id` 和 `(project_id,stage_id)` 唯一，首次候选原子占位并阻止并行不同候选。完全相同签名、幂等键、冻结内容重放只返回原行；不同尝试拒绝。未来正式的重开/替代受控决议需要另外设计，不能覆盖历史。
- **事件原子性**：候选、`audit_events` 与 `outbox_jobs` 同事务；延期触发器要求对应审计和 trial-only outbox 均存在。outbox kind 限定为 `dhf.pilot.gate.candidate`，绝不能由生产 CDW 部门分发/生效消费者视作正式批准。

## 3. 代码和数据结构

`migrations/0054_dhf_pilot_signed_gate_candidates.sql` 定义不可变 `dhf_pilot_gate_candidates`（G5/G6、最终审核人、冻结提交、认证 Gate 决定、原始/数字签名摘要、签名公钥、唯一项目阶段及幂等键），来源检查和同事务 audit/outbox 延迟检查。数据库仍不允许正式 Gate `accepted`，没有扩展既有 Stage Position CHECK。

`internal/application/dhf_pilot_gate_candidate.go` 新增 `DHFPilotGateChallenge` 与 `DHFPilotSealGateCandidate` 两个**暂不暴露 HTTP 的内部试点命令**；真实 Actor、当前密码、已指派 Gate、Ed25519、公钥信任锚、冻结物理证据和幂等均重新检查，不能使用客户端提供的批准状态。适配器 `internal/adapter/postgres/dhf_pilot_gate_candidate.go` 原子写入候选、不可变审计和 trial-only outbox。

鉴于缺少企业批准的签署策略、独立身份服务和生产密钥生命周期制度，本版**特意不增加“正式批准”按钮或写 HTTP Gate finalize 路由**。已有统一工作台的逐级审核、身份确认及整改复验可继续使用。

## 4. 实际测试证据与待验收

验收环境仅使用 `root@10.144.144.1` 的隔离开发检出、PostgreSQL 17 一次性库和生成的随机**测试私钥**；不会把测试私钥纳入仓库。

| 必要验证 | 期望 |
|---|---|
| PostgreSQL 迁移从空库执行 | 56/56 |
| 公钥环境项缺失 / 非法签名 / 非 Gate 责任人 | 全部拒绝 |
| 无本人当前文件 ACL | Gate 候选拒绝 |
| 手工写候选但缺同事务审计或 outbox | 拒绝 |
| 受信任测试公钥对应的私钥合法签名 | 独立试点候选产生且 stage 仍 submitted |
| 候选公钥和签名离线重验 | 历史字节可以独立验证 |
| 同键幂等重放 / 候选 UPDATE 或 DELETE | 原记录返回 / 非法修改拒绝 |
| G6 整改、原版冻结 PDF/DOCX 与来源 ACL 回归 | 不可回退 |
| 生成 OpenAPI、验收矩阵、Go 全量测试及构建、Vite | 以实际结果判定 |
| 企业正式密钥签署 SOP、电子签章法规验收、CAS stage accepted、CDW 分发 | **NOT_RUN / NO-GO** |

### 远端测试实际结果（2026-10-24）

执行位置：`10.144.144.1` 的独立 Git 检出、一次性 PostgreSQL 17 测试数据库及随机生成的进程内 Ed25519 测试密钥。测试密钥未提交、未部署。

| 断言 | 观察结果 |
|---|---|
| 56 项 migration 从空库执行及二次 checksum `-check` | **PASS** |
| 缺失信任公钥、无效签名、错误审核人 | **PASS，均被拒绝** |
| 只有现有 Gate 密码再认证但没有文件预览 ACL | **PASS，被拒绝** |
| 伪造候选但没有同事务 audit/outbox | **PASS，被拒绝** |
| 真实授权 Gate + 本人当前口令 + 临时测试私钥 Ed25519 签名 | **PASS** |
| 从数据库重新读取签名和历史公钥独立 Ed25519 验签 | **PASS** |
| 同幂等键重放与候选篡改 | **PASS：重用原 ID / 拒绝修改** |
| Gate 候选成功后 Stage Attempt 保持 submitted | **PASS，无正式批准的越权状态转换** |
| G5/G6 逐级签审、G6 整改复验、旧版 PDF/DOCX 字节固定预览 | **PASS，真实 PostgreSQL 集成** |
| `python3 scripts/gen_openapi.py --check` | **PASS：139 paths**（本版无新 HTTP 路径） |
| `python3 scripts/gen_acceptance_matrix.py --check` | **PASS：126 IDs / 123 PASS / 3 PARTIAL** |
| `go test ./internal/... -count=1` + `go vet ./internal/...` + 3 个 Go 后端命令构建 | **PASS，退出码 0** |
| `npm --prefix web run build`（TypeScript/Vite） | **PASS，退出码 0**；原 Three.js 大 bundle / 动态导入提示保留 |
| 浏览器三尺寸、正式签名政策、正式 accepted CAS、CDW 部门签收 | **NOT_RUN / NO-GO** |

**局限：** PostgreSQL 能强制来源关联、任务/证据/整改完成、不可变审计及 outbox 原子性，但 PostgreSQL 触发器本身不做 Ed25519 验签；当前服务应用层在落库前使用外部公钥进行密码学核验。具有数据库超级用户权限者仍可能伪造数据库记录，因此正式投产还须独立信任域与外部可验证签名证明和操作权限隔离。本版的公钥来自隔离测试环境，不是企业批准的公钥身份管理制度。

## 5. 不可解除的生产门禁

正式 `accepted` 事务必须另具：1) 由公司质量/研发主管批准的生效模板及责任人清单，且可校验签署授权、密钥撤销与寿命；2) 被企业认可的身份认证强度、签名算法和可信时间源；3) 全 G1–G9 已批准要求适用性和 Gate 依赖；4) 正式 Stage Position 状态 CAS 及统一提交审计/outbox（区别于本次 trial candidate）；5) 不完整或不符合的整改关闭严禁批准；6) 受控 CDW 文件发行、部门签收和培训另行验收。原始 XMind 的暂定文件名、括号数量及模板示例不能直接作为法定必交条件。

**结论：V0.7.4 是可独立验签的试点 Gate 决议候选和原子审计基础，不是正式阶段批准功能的部署授权。**
