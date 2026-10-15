# CDW G1 — 可执行负例验收清单（设计稿）

> 2026-10-15，配套 `CDW-G1-DDL-01-TASK-OFFICE.sql` 与 `CDW-G1-DDL-02-RELEASE-DISTRIBUTION.sql`。
>
> 仅定义测试，不表示已连接 PostgreSQL、执行 migration 或清理测试数据。旧测试数据无需迁移；新系统产生的审查/批准/发行/签收证据必须保持不可变。

## 测试环境门禁

必须使用经过独立确认的远端隔离 PostgreSQL 17 临时数据库，重放基础 migrations，再按 01→02 顺序加载草案。禁止把这些 SQL 草案直接放入自动迁移目录或在现有运行库上测试破坏性用例。若需删除任何既有 DB/Blob，须另行取得明确授权。

夹具应包含 F1/F2 两份文件、B/C 独立工作分支、不同真实 Blob 哈希、受控发行 R1/R2、部门 D1/D2、管理者 A、上级 B、执行人 C、正式审批人、文控员和有权部门签收人。

## PostgreSQL 负面约束用例

| ID | 制造的错误 | 应当拒绝的约束 |
|---|---|---|
| DB-01 | F1 manifest item 引用 F2 的基准版本 | file_id + version_id 复合 FK |
| DB-02 | 同一任务两份未结束的 primary assignment | 部分唯一索引 |
| DB-03 | assignment 同时有 user_id 和 group_id，或均为空 | CHECK |
| DB-04 | 子任务自指为父，或 parent 与 root 不一致 | CHECK / 复合 FK |
| DB-05 | branch revision 的 parent 来自另一个 branch | 复合 FK |
| DB-06 | B 的 delivery item 引用 C branch revision 或修改 blob/sha | branch/revision/blob/hash 复合 FK |
| DB-07 | delivery 关联其他任务或轮次的 freeze | freeze/task/round 复合 FK |
| DB-08 | review gate 或 return order 的 round 与 delivery 不同 | delivery/gate/round 复合 FK |
| DB-09 | Office callback 把另一 session 的 request 冒充为自己的 | request/session 复合 FK |
| DB-10 | 已交付内容、branch revision、审批 subject 或签收凭证被 UPDATE/DELETE | append-only trigger |
| DB-11 | approved_candidate.sha 与所批准的 subject.sha 不一致 | subject/file/hash 复合 FK |
| DB-12 | 将 F1 的 approved_candidate 用于 F2 的正式发行 | candidate/file 复合 FK |
| DB-13 | batch item 不属于批准计划，或 artifact/sha 被换 | 计划/发行物复合 FK |
| DB-14 | batch target 部门或接收人不在批准计划 | target/plan 复合 FK |
| DB-15 | scope approval 或 batch 的 planDigest 与冻结计划不同 | plan/digest 复合 FK |
| DB-16 | target_item_requirements 引用别的 batch | 双复合 FK |
| DB-17 | receipt item 引用非该 batch 的 SHA | batch/item/hash 复合 FK |
| DB-18 | D1 receipt head 指到 D2 receipt | target/receipt 复合 FK |
| DB-19 | 阅读 assignment 或确认事件引用错误 artifact SHA | assignment/item/hash 复合 FK |
| DB-20 | 纸质 copy 的 release 不属于其 issue lot | lot/release 复合 FK |
| DB-21 | issue lot 声称发五份，仅编号四份就冻结 | 数量 freeze trigger |
| DB-22 | 来自 D1 分发目标的授权引用 D2 batch item | target/item/release/artifact 复合 FK |
| DB-23 | B 的审查批注以 A 分支文件身份保存 | anchor/branch/file 复合 FK |
| DB-24 | 派发时篡改已批准部门的签收、阅读或实施要求 | plan_target_requirements → target_item_requirements 复合 FK |
| DB-25 | 批次 item 同时带 plan_id 和 batch_id，触发器选错父记录 | 锁 batch_id 所属 batch；只允许 draft 变更，冻结后拒绝 |
| DB-26 | 批次的某目标文件不存在于已批准的部门/文件集合 | plan/item/department/ordinal 两端复合 FK |

SQL 只证明数据库关系一致，不能证明对象存储的 SHA256 真的与内容字节匹配。必须由服务端计算真实 Blob Hash 并在事务中核验。

## Go 应用事务与授权并发用例

| ID | 场景 | 正确结果 |
|---|---|---|
| TX-01 | A→B→C，授权高层越级验收 C | 被替代 gate 有真实审核人，A/B 原管理与整合义务保持 |
| TX-02 | 越级授权过期、撤销或无 substitute 权限 | 403，零成功审计 |
| TX-03 | 两个事务跨 root 互相建立依赖 | 全局图锁及环检测阻断其一 |
| TX-04 | ONLYOFFICE force-save 命令成功，最终 callback 未持久化 | 不可提交交付 |
| TX-05 | 旧保存回调迟到、同一回调重复、协作窗口有未保存修改 | 不覆盖原交付；阻断未完成 freeze |
| TX-06 | B/C 同文件不同分支并发编辑 | 两条隔离修订，正式/受控版不变 |
| TX-07 | 两个部门接收人竞态签收同目标 | 至多一个有效 head，操作者真实 |
| TX-08 | 通知送达/首次打开被当成签收或个人已阅读 | 拒绝状态推进 |
| TX-09 | Idempotency-Key 相同但 body 或条件版本改变 | 409，不能生成新凭证 |
| TX-10 | 批准后增加部门/纸质数量或替换发行物 | digest 校验失败，必须重新范围确认 |
| TX-11 | 新版已批准但未生效 | 普通预览/下载/打印/搜索只见当前合法有效版 |
| TX-12 | 生效时刻到但关键部门未签收，调度器又重启 | 不生效；可重试并记录 blockers |
| TX-13 | 激活与撤回竞态 | 唯一全局 effective pointer 不出现非法版本 |
| TX-14 | 发行 PDF 后图章或转换产物更改 | 既有发行 Blob、历史签收 Hash 完全不变 |
| TX-15 | 接收人的授权已撤销后用旧 Range URL | 服务端重验权，拒绝取内容 |
| TX-16 | 删除/GC 与仍有效的发行物引用竞态 | 新证据和 Blob 不得被破坏 |
| TX-17 | 写入 outbox 后事务回滚 | 无成功广播、无伪完成 |
| TX-18 | 纸质发五份只回收四份 | 准确显示尚欠一份 |
| TX-19 | 未启用培训流程 | 没有培训率，也没有隐式培训生效阻断 |

## 前后端集成验收

工作台首页首屏展示待办和审批，不展示重复的“页面名称”标题；分发签收使用清晰表格：部门、指定接收人、实际接收人、发放时间、实际签收时间（到秒）、版本、内容 Hash、个人阅读完成数、纸质数量及回收状态。点击行能查看发行物、签收声明与事件历史。所有入口复用 RareUI 和现有文件上传/预览基础设施，不在签收或工作台页意外移除 OS 拖拽上传。

## 当前通过范围

可在本地对 SQL **文本**做：创建顺序、引用表、唯一键、文档相互引用等静态校验；不能据此声称 PostgreSQL 语法、触发器、并发锁、ONLYOFFICE 保存链、权限和生产运行已经通过。

完成真正 G1 门禁必须提交：临时库环境标识、实际 SQLSTATE、并发结果、Go E2E、浏览器截图、真实最终文件 Hash 对照。**本文没有执行上述实验。**
