# DHF V0.6.5：真实 Blob 字节校验与受控保留复验

> Document ID: DHF-ENG-BLOB-VERIFY-20261024-01  
> Version: v0.6.5-draft · Date: 2026-10-24  
> Status: **remote DEV validation passed; business approval and production activation blocked**  
> Branch: `feat/dhf-v06-gate-pilot` · PR #1  
> Basis: [开发文档准则](../DEVELOPMENT-DOCUMENTATION-STANDARD.md), [DHF 九阶段文件准则](DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md), V0.6.4 提交约束

## 1. 事实性审查：现有 BlobStore 如何清理文件

对 `internal/adapter/blob/store.go`、`resumable.go`、`internal/application/trash.go`、`cmd/server`、`cmd/worker`、`scripts` 的实际代码和远端源码检索后：

- `SweepStaging` 清理超时 staging 临时文件；`RemoveResumable` 清理断点续传临时分片。
- 受控 `ready/<分片>/<SHA>` 正式 Blob 当前**没有暴露的通用物理删除/GC 实现**。
- Trash 永久清理不直接删除 ready 文件，Blob 回收仍属于后续 GC 任务。
- PostgreSQL `blobs.state='gc_pending'` 不等于磁盘对象已被删除。
- 操作系统管理员、备份恢复工具、外部脚本仍然可能绕过应用数据库删除或损坏字节，数据库约束不能阻止有权限的文件系统直接操作。

**本版不引入 ready 文件删除方法；未来任何物理 GC 都须在释放前读取持久证据引用和业务保留策略，并进行原子竞争验证。**

## 2. 代码与 SQL 新增内容

| 文件 | 内容与安全效果 |
|---|---|
| `internal/application/dhf_pilot_blob_integrity.go` | 对 BlobStore 真实文件以 64KiB 缓冲流式计算 SHA-256 和长度；错误、取消、内容不匹配均拒绝 |
| `internal/application/dhf_pilot_eval.go` | 对 `submit` 的每份绑定证据追加物理字节校验；只靠 DB 元数据、版本或 ready 状态不足以成功提交 |
| `internal/application/dhf_pilot_blob_integrity_test.go` | 实测有效字节、同长度篡改、大小不符、文件缺失、缺少 BlobStore、取消的负例 |
| `migrations/0046_dhf_pilot_blob_identity_hold.sql` | 提交证据引用的 Blob 不得通过 SQL 修改 storage_key、sha256 或 size_bytes；与既有 gc_pending/DELETE 数据库防护配合 |
| `internal/adapter/postgres/dhf_pilot_submission_integration_test.go` | 使用真实 BlobStore 写入测试字节，真实 Go+PostgreSQL 提交；修改磁盘文件但保留正确 DB 元数据时，提交必须拒绝；DB Blob 关键字段篡改也必须被拒绝 |

## 3. 实际远端执行证据

- 目标：`root@10.144.144.1`，隔离 Git 检出 `/tmp/filesmanage-dhf-v062-G1B4hb`。
- 已验证 HEAD：`50a7bcf`。
- `go test ./internal/application -run '^TestDHFPilotPhysicalEvidence' -count=1` → PASS。
- `go test ./internal/... -count=1` → PASS，退出码 0。
- `go vet ./internal/...` → PASS。
- `go build ./cmd/server ./cmd/worker ./cmd/migrate` → PASS。
- 使用仓库 `cmd/migrate` 在独立 PostgreSQL 17 测试库完整执行并 `-check`：**48 个迁移 PASS**。
- 真实数据库集成 `TestDHFPilotRealPostgresSubmission` → PASS；含并发提交唯一性、撤销 ACL、来源哈希一致性、磁盘同长度篡改、Blob GC 阻断及 storage_key/sha256/size_bytes 修改负例。
- 集成测试仍输出原始的 `DHF_V064_DB_INTEGRATION_PASS` 标志，表示测试函数沿用既有名称，并非只验证到 V0.6.4。
- 以上数据库均为一次性隔离测试数据；未在运行的业务数据库执行迁移，也未重启正式服务。

## 4. 安全限制与下一阶段门禁

**本版验证的是“提交瞬间字节真实且准确”，不是“提交后永远不会遗失物理字节”。**

- DB 引用会拦截应用层依赖的 `gc_pending` 和 Blob 记录删除/字段篡改，但有文件系统权限的外部操作仍能直接影响 ready 文件。
- 如果外部操作发生在检验之后，数据库不可能自动检测磁盘丢失；正式 Stage Gate 最终审核还应重新验证证据，或由可信后台周期性完整性检查和故障告警保护。
- 长文件同步重新计算 SHA 有 I/O 和事务持锁成本；后续需进行大文件、并发与 LAN 压测，避免用缓存弱化证据真实性。
- 受控备份与灾备恢复需要具体验收：存储根目录权限、对象保留、manifest 对账、缺失修复和恢复后 SHA 复验。
- 正式模板签审、G5 专业审核与工作台责任链、条件放行、整改闭环、阶段正式批准均尚未交付；不得从试点 `TrialOnly` 判定推导正式合规结论。
- PR 必须保持 Draft / NO-GO，等待上述生产授权和端到端验收。

**结论：物理 Blob 内容核验和数据库字段保留防护已落地并在远端真实验证；完整物理保留与恢复保证仍是后续明确的 P0 门禁。**
