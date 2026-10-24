# DHF V0.6.2 — 可信快照加载与只读预检合同

> 文档 ID：DHF-ENG-SNAPSHOT-20261024-01  
> 版本：v0.6.2-draft · 2026-10-24  
> 状态：代码已提交开发分支；**数据库迁移未执行、远端 Go 编译/测试 NOT_RUN、审批/API/UI 未接入**  
> 相关规范：`docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`、`docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`  
> 源文件：DHF 1–9 阶段 XMind TXT；SHA-256 `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`。

## 1. 实施范围

- 独立迁移：`migrations/0043_dhf_pilot_snapshot_read.sql`；仅创建 `dhf_pilot_*` 数据域和历史防篡改触发器，不修改现有审批业务。
- Go 端口：`internal/ports/dhf_pilot.go`；附着于现有 `ports.Tx` 的可选只读接口，不要求旧 mock 自动实现。
- PostgreSQL：`internal/adapter/postgres/dhf_pilot.go`；在真正的 `pgx.Tx` 上首先设置 `REPEATABLE READ, READ ONLY`，读取同一数据库视图。
- Application：`internal/application/dhf_pilot.go`；只读 `DHFPilotPreflight(ctx, actor, attemptID, action)`，应用层而非 HTTP 请求构造 `dhf.GateInput`。
- 单元测试：`internal/application/dhf_pilot_test.go`；覆盖不授权动作、缺证据、缺权限、缺依赖、伪造哈希、未知 JSON、缺少必须布尔配置、未发布模板。
- G5 专业审核/条件签批仍属于 V0.6.1 的领域合同；本版**没有**实现正式批准命令。

## 2. 数据模型及保留边界

| 实体 | 当前定位 | 关键约束 |
|---|---|---|
| `dhf_pilot_templates` | 策略草案/已批准发布快照 | `policy_body`+`policy_sha`；获批身份/时间，已发布/撤回后不可改写或删除 |
| `dhf_pilot_projects` | 试点项目 | 草稿/启用/暂停/关闭 |
| `dhf_pilot_members` | 项目行动能力 | 只允许明确授权的 `can_prepare/can_submit`；不含批准权 |
| `dhf_pilot_baselines` | 项目按阶段绑定模板 | 项目、阶段、模板复合键；需 active |
| `dhf_pilot_attempts` | 当前交付尝试和清单 | 清单本体及 SHA；提交后不能改写/删除冻结证据 |
| `dhf_pilot_stage_positions` | 前置阶段的状态投影 | **本试点数据库禁止接受 accepted/conditionally_released 投影**，直到有独立签审服务与审计记录；不允许伪造上游已批准 |

九阶段使用 G1–G9 固定身份；G6 首次转移与 G8 再次转移不合并。XMind 可见节点不得根据标题括号数量直接变为正式 mandatory 规则。

## 3. 策略 JSON 和清单 JSON

`dhf_pilot_templates.policy_body` 必须为 UTF-8 JSON 字节，使用以下示意结构；实际字节计算 SHA-256 后写入 `policy_sha`。G1 示例只用于**隔离测试项目**，不代表已批准的业务规则。

```json
{
  "stage_id": "G1",
  "conditional_allowed": false,
  "requirements": [
    {
      "ID": "REQ-DEMO-001",
      "SpecialtyKey": "",
      "Mandatory": false,
      "Critical": false,
      "ConditionEligible": false,
      "AllowNotApplicable": false
    }
  ],
  "dependencies": [],
  "specialties": []
}
```

需要注意：需求条目中的 Mandatory / Critical / ConditionEligible / AllowNotApplicable 不得省略，否则解码必须拒绝，不能把未填写的 Mandatory 默认成 false。真实项目不得使用示例要求、默认授权或测试账号产生正式合规结论。

`dhf_pilot_attempts.manifest_body` 示例：

```json
{
  "requirements": [
    {
      "id": "REQ-DEMO-001",
      "applicability": "applicable",
      "file_id": "",
      "version_seq": 0,
      "sha256": ""
    }
  ]
}
```

真实必需文件必须绑定确定的文件 ID、版本序号、SHA；`EvidenceVerified` 必须由服务端检查实际 `file_versions` + `blobs` 就绪状态 + 有效文件 ACL。无文件但为非必需要求可仅用于草稿/只读演练。对 `not_applicable` 的独立审批尚未实施，因此目前永远不能仅凭 JSON 宣布已授权 N/A。

## 4. 可信预检步骤

1. 只接受用户身份、attempt_id 和 `prepare/submit`。
2. `ports.UnitOfWork.Begin` 创建现有 pgx 事务；设置重复读、只读，拒绝池对象直接调用。
3. 根据尝试、项目基线、有效用户、项目成员能力过滤数据库记录，禁止客户端提供任何 GateInput 布尔值。
4. 重新计算原始策略和 manifest 字节的 SHA-256；核对存储哈希；严格解码 JSON。
5. 校验发布状态、审批身份、项目/阶段/模板一致性。
6. 按 manifest 逐项核对特定文件版本及 Blob SHA、状态；只有现有文件下载权限允许时，才算证据对该用户可验证。
7. 从相同项目的服务端阶段投影加载**每一个**策略前置依赖；缺少投影归类为准备中，不能解释为无依赖。
8. 调用 `dhf.Evaluate` 得到策略诊断，但返回结果 `AdvisoryOnly=true`，且从不提交任何写事务。

**关键限制**：SQL 中的策略 published 状态和批准人字段不等于合格的电子签名服务。当前试点没有签审工作流、受控发行、真正的项目批次创建和审核任务，也没有完成 Blob hold 与 GC 互斥，因此成功预检不得当成可以提交审批的授权令牌。

## 5. 仍未关闭的发布阻断

| 编号 | 阻断内容 |
|---|---|
| V062-P0-01 | 正式模板管理、内容哈希、授权审批、冻结和撤回事务 |
| V062-P0-02 | 专业审核、阶段通过/退回、审批人和独立责任链写事务 |
| V062-P0-03 | 已签署前置 Gate 决定与阶段投影一致性；本试点有意禁止直接写“已批准”投影 |
| V062-P0-04 | 证据 Hold、Blob GC 保护、提交批次签名和不可变回溯 |
| V062-P0-05 | 鉴权、CAS、幂等、审计/outbox 原子提交及重复请求处理 |
| V062-P0-06 | 受控文件发行仍归属 CDW 独立服务，不得通过本预检授权 |
| V062-P0-07 | 远端迁移 dry-run、Go 测试、集成测试、安全负例和真实浏览器验证 |
| V062-P0-08 | G5 软件/工艺和 G6 原始需求的正式业务裁决、责任授权和适用性 |

## 6. 本轮验证事实

代码仓库：`feat/dhf-v06-gate-pilot`，草稿 PR #1。  
已完成：代码提交、静态读取及分支文件复核。  
未完成：真实 Go 编译、`go test`、数据库迁移、端到端审批及部署。  
连接阻断：当前可用 Runner 上的 `deploy-host` SSH 别名解析失败；未采用本地构建/测试替代远端验证。需要授权远端执行入口后才能提供 PASS 证据。
