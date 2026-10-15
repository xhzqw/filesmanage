# CDW G5 — 真实 ONLYOFFICE 编辑、保存栅栏及活动会话续约门禁（2026-10-15）

> 状态：隔离浏览器/数据库 E2E `CDW_G5_REAL_ONLYOFFICE_E2E_PASS`；面向用户的系统仍为**开发试运行**，正式受控发行未达到 GO。

## 1. 真实环境和隔离边界

- 远端唯一工作机 `192.168.1.22`，真实 Docker ONLYOFFICE Document Server `18080`，真实 headless Chrome。
- **专用** PostgreSQL 17 数据库 `cdw_g5_oo_iso_20261015`（49 项历史迁移）、专用 Blob 根 `.backups/cdw-g5-oo-20261015/blobs`、专用短时编辑测试 HTTP `18095`；显式测试标志与严格的数据库名称、Blob 路径、服务地址三重核验。默认执行测试会自动跳过。绝不能指定开发业务库 `filesmanage_v21` 或生产入口 `8091`。
- 测试角色、文件、任务、工作分支只使用隔离库中的 fixture，**不借用线上用户口令**。测试源码/运行日志不打印 Document Server JWT 或连接密钥。
- 测试端口结束时关闭；隔离库及其文件保留以供离线证据分析，不能误称“自动清理完成”。

## 2. 已验证的完整链

1. 构造合法的最小 DOCX 并经业务上传事务生成 formal `file_versions` 第 1 版。
2. 服务端创建根任务、接收、创建工作分支、签发 ONLYOFFICE `document.key`、编辑配置、source capability JWT。
3. 真实浏览器加载 Document Server `api.js` 并打开工作稿，收到 `onDocumentReady`。
4. Chrome 使用真实鼠标键盘向跨域 ONLYOFFICE iframe 输入独立文字；收到 `onDocumentStateChange(true)`。
5. **立即**提交 CDW 保存请求，真实 `/command` force-save `userdata` 绑定持久化 request ID；Document Server 在协作更改刚开始传播时可能回复 `error:4`（暂无变更可保存）。
6. 新的有界后退机制仅在 `error:4` 时使用**完全相同的 `userdata`、document key 和签名命令**短暂重试，最长约 6 秒；其他非零代码立即失败，不通过隐式新请求逃避幂等约束。HTTP 的 `error:0` 仍只是“命令接收”，不冒充落盘完成。
7. Document Server 通过带 JWT 的真实 callback 返回可下载的修订内容，服务端做来源限制、OOXML 验证、blob commit、回调去重、session/generation/epoch 栅栏。
8. 精确匹配本次 request 的 `persisted` 数据库回执及 branch head 修订后，冻结独立交付，创建直属审核 gate；原 formal `current_version_seq` 必须仍为 1。
9. 真实 E2E 输出：`CDW_G5_REAL_ONLYOFFICE_E2E_PASS document_ready=1 edit=1 callbacks=2 ... original_version=1`。此 PASS 是**真实 Office 编辑+保存+冻结**，不是仅 mock `/command`。

## 3. 会话续约和安全关闭

- `POST /api/work-branches/:id/office-sessions/:sessionId/heartbeat`，已认证、必须为当前活动责任人且持续具有文件预览 ACL。
- 在同一个事务内，数据库仅允许在 `session.state='open'`、`ended_at IS NULL`、`session.expires_at>now()`、`branch.state='open'`、`branch.edit_epoch=session.edit_epoch` 时延长至最少“当前时间 +30 分钟”；绝不续活已过期、已冻结、旧 epoch 或非本人会话。
- React 分支编辑页每 60 秒续约，浏览器从隐藏变为可见时立即核验；403/409/401 时阻断本次交付冻结，显示可操作的会话失效反馈。
- 同一用户再次打开尚有效的独占编辑 session 时刷新 lease；旧 source JWT 仍须有**当前活跃 session**才能读取，且 callback 在下载之后仍以事务内分支 epoch 复核。
- 专用 PostgreSQL 回归包含当前责任人续约成功、他人/伪 session 续约失败、冻结后旧会话无法续约，以及原有审核/退回两轮结果。

## 4. 相关代码 / 复现

- `internal/application/cdw_branches.go`：`cdwSendForceSaveCommand` 有界重试、`CDWTouchBranchOffice` 和分支 source guard。
- `internal/adapter/postgres/cdw_branches.go`：租约 SQL CAS；`internal/httpx/cdw_branches.go`：新 heartbeat API。
- `web/src/pages/CDWBranchEditor.tsx` 和 `web/src/features/cdw/api.ts`：自动续约和不可恢复 lease 反馈。
- `internal/application/cdw_force_save_test.go`：错误 4 的同一命令重试；其他错误不重试；取消立即终止。
- `internal/adapter/postgres/cdw_real_office_e2e_test.go` + `scripts/cdw_g5_real_editor_browser.mjs`：真实浏览器与 Document Server，默认跳过，仅隔离环境且显式开关运行。
- G5 真实测试需变量：`CDW_G5_REAL_OFFICE_E2E=1`、`CDW_G5_TEST_DSN`、`CDW_G5_BLOB_DIR`、`CDW_G5_SOURCE_BASE`，以及远端已有 ONLYOFFICE 配置。严格防误连已写入测试源码。

## 5. 不能据此宣称完成的功能

- React 生产路由下“完整人工点击审核、分发”的多用户 E2E 尚需浏览器覆盖；G5 真实浏览器验证的是**嵌入的同一 DocsAPI 和应用服务端写入路径**，不能把它偷换成全系统认证 UI E2E。
- 长于 30 分钟的实际编辑时长尚未人工计时验证，已经通过续约 SQL/API 权限与冻结测试；应追加跨会话/掉线恢复和失联超时专项测试。
- 未启用模板授权的越级替代 gate / 不免除中间责任相关授权接口，尚缺 `grant/revoke`、`acting_for` 审计和工作台。
- 正式文件批准、受控发行、版本生效指针、部门签收及人员阅读确认仍必须作为后续独立状态机完成；**培训模块和培训率继续不纳入设计**。
