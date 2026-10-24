# DHF V0.6.8 — 受权固定版本证据清单与受控内容预览

> Document ID: DHF-ENG-PINNED-EVIDENCE-20261024-01  
> Version: V0.6.8 development draft · Date: 2026-10-24  
> Status: **DEV verified on isolated DB, NO-GO for production stage approvals**  
> Branch: `feat/dhf-v06-gate-pilot` · PR #1  
> Governance: `docs/DEVELOPMENT-DOCUMENTATION-STANDARD.md`; `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`.

## 1. Sources and boundary

G5 专业审核和 G6 第一次设计开发转移继续使用原始九阶段 DHF XMind 作为来源参照；原文节点的必交裁决仍由受权模板发布承担，不能凭同名文件自动复用。本版仅将现有提交 `dhf_pilot_submission_evidence` 的不可变记录变成可核查的审核证据，不改变受控文件的原审批、电子签署或部门分发责任链。

**关键原则：项目审核任务身份 ≠ 文件访问权限。** 只有在当次请求同时满足（1）真实用户账号和项目成员有效，（2）审核任务明确指派给该用户，（3）项目与模板仍有效，（4）该用户本来就具有对应原文件的 `preview` 权限时，才能获取文件名称、固定版本元数据或预览内容。

## 2. 接口

- `GET /api/workbench/dhf/tasks/{id}/evidence`：返回授权审核人的固定要求 ID、文件 ID、文件名、**提交时版本序号**、SHA-256 和长度。隐藏内部 Blob storage_key。每次独立检查原文件 ACL、固定版本记录和 Blob 元数据。
- `GET /api/workbench/dhf/tasks/{id}/evidence/{rid}/preview`：重新检查上述权限和原始证据引用，**按同一固定版本**重新读取 Blob 真实物理字节、校验 SHA-256 和大小，然后使用当前既有预览管线返回有限大小的内容/结构信息。额外标记 `fixedVersionVerified=true`。
- 两者均使用受认证的只读事务，`Cache-Control: private, no-store`；只有符合 ACL 的文件身份才进入响应。
- `/approvals` 工作台显示要求/文件名/固定 vN/完整 SHA-256；点击后才按当前权限执行实际内容校验。
- **不谎称完整 Office/PDF 版式**：当前仅文本/受控的有界结构或安全媒体元数据，不能把普通文件当前版本的预览当成受控固定版本。正式审核前的 Office/PDF 精确页渲染是独立下一阶段门禁。

## 3. 实际工程验证

V0.6.8 在 `root@10.144.144.1` 的 Git 独立检出及 PostgreSQL 17 一次性数据库执行。代码/文档收尾提交基线：`9751042`；前端与 Go 完整回归基于 `a88c89f`（后续仅新增测试与文档，实际集成按最新基线重跑）：

| 测试 | 执行方法 | 结果 |
|---|---|---|
| 原始 51 迁移 | 使用仓库 `cmd/migrate` 从空库加载 | PASS |
| 权限拒绝 | 专业审核人虽有任务，未获得原文件 `preview` ACL | PASS |
| 明确授权 | 给该文件添加受控预览 ACL，再列出两条正确 v1 证据 | PASS |
| 禁止凭任务绕过成员身份 | 提交人使用审核任务 ID 尝试读取 | PASS，拒绝 |
| 防止“最新版本冒充证据” | 受控文件当前指针转至 v2 后请求原提交 v1 | PASS，内容和 SHA 仍与 v1 一致 |
| 磁盘物理篡改 | 相同字节长度的磁盘内容变化后，审核人重新预览原固定 v1 必须失败 | **PASS** |
| Go 全包与 Vite/OpenAPI 构建 | `go test ./internal/... -count=1`、`go vet ./internal/...`、Go build、Vite production build、OpenAPI 和验收矩阵 `--check` | **PASS**，退出码 0，129 API paths |

## 4. 未完成事项

1. PDF/DOCX/其他专业格式的**固定文件版本**页图与版式渲染、OnlyOffice 的只读审阅关联，必须保证 `file_id,seq,sha256` 不被无意换成最新版；
2. 每个专业明确的证据范围和审阅批注引用，避免项目成员凭任务增加原本不具备的 ACL；仍需在正式规则中固化；
3. 已完成/退回任务的责任历史与证据链全局查询、版本冻结后的周期完整性检查和物理保留；
4. 后续 Stage Gate 正式批准签章身份、逐级审核链、受权越级不豁免责任、整改复验、条件放行；
5. 浏览器桌面/笔记本/窄屏真实验收。**技术功能测试通过 ≠ 企业 SOP 已签审。**

**NO-GO：** 不合并为生产审核入口，不把试点 `recommend_pass` 等同正式设计开发阶段验收。
