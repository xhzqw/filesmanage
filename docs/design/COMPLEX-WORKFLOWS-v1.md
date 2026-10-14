# COMPLEX-WORKFLOWS-v1 — 复杂交互与 API/事务合同

> 项目：filesmanage v2.1 · 版本：1.0.0-draft · 2026-10-09 · 仅设计，不代表服务端已具备新增 API
>
> **事实先行**：当前已审代码为本地 Go/Gin + React 新工作副本，远端为唯一运行事实；未登录实际业务页面，静态缺口需要远端 E2E 再签收。禁止为补 UI 而削弱 ACL、审计、幂等、CAS、事务或版本不可变语义。

## 0. 接口与产品现状对照
| 能力 | 代码事实（审计时） | 缺口/策略 |
|---|---|---|
| 目录移动 | `POST /api/folders/:id/move`：`internal/httpx/router.go:98`、`features/folders/api.ts:10` | UI 没有 FolderPicker 或目录移动入口 |
| 文件移动 | `internal/httpx/router.go:103-112` 未定义 `/files/:id/move` | **需补正式业务/API 合同**；不可假冒已有 |
| 版本回滚 | `/files/:id/rollback` 已有；预览页只列历史 | 补可见的回滚动作、锁/审批/CAS/理由流程 |
| 分享创建 | `/shares` POST、`collaborationApi.createShare` 已有 | 列表界面没有完整创建分享向导 |
| 收藏添加 | `setFavorite` API 已有，列表页只有取消 | 文件/目录详情与列表增加关注入口 |
| 文件上传 | multipart 单文件流式服务端，前端文件选择只取第一个 | 多文件队列、逐项反馈、重试/取消；非断点分块协议 |
| 回收站恢复 | REST 接受 `destinationFolderId/newName` | UI 固定传空字符串，无法主动解决目标丢失/重名 |
| 权限授予 | 服务端 `ExpiresAt` 支持；客户端只送四项基础字段 | 有效期 UI、真实 user/group 数据源、有效权限解释 |
| 组织管理 | Users/Groups API 存在，部门列表存在 | 页面尚未实现规范要求的分层部门+成员工作台 |
| 错误语义 | `shared/http.ts` 丢失 `error.code` | 所有操作必须改为统一 ApiError |
| 文本编辑 | `FileEditor.tsx` 使用截断上限预览字段保存 | **先做防截断/非文本禁止保存安全门禁** |

静态证据受版本影响；开工前验证 `local HEAD = remote HEAD` 和最新 OpenAPI，发现实现已经演进时先更新此表。

## 1. P0 安全门禁：Safe Text Editor

### 1.1 风险
`web/src/features/documents/FileEditor.tsx:20-24,49-68` 使用 `fileApi.preview` 的 `preview.content` 作为完整可保存正文；预览最多 256 KiB，返回 `truncated`、`textual` 与 `byteMeta`。若未检查完整性，将不完整内容写为新版本，可能造成不可接受的数据内容变更。

### 1.2 必须满足
- `textual === true`、`truncated === false`、可安全识别编码/行尾/字节转换时，才允许纯文本编辑和提交。
- 尽可能走独立**完整字节编辑读取路径**，与只读预览区分；若未引入完整安全读取，则超过预览阈值一律禁编辑并提示可下载/使用其他编辑器。
- BOM、CRLF/LF、末尾换行和编码语义不得被无意归一化；变更“字节保真策略”需要明确编辑能力边界与测试。
- 已读取内容若失权、锁 token 失效、baseSeq 变更，阻断保存并提供刷新/保留本地草稿的安全选项；不得偷偷覆盖现版。
- 未签入草稿不进入版本列表；审批 `202 pending` 不显示为 committed。
- 弹窗关闭前检查脏状态；释放锁以服务端事实为准，不因异步释放失败悄悄遮蔽正在被其他人编辑的警告。

### 1.3 验收
只用隔离测试文件验证 0B、含 BOM、混合 EOL、256 KiB 边界下、刚好超限、非文本和并发锁场景；对失败路径断言原始最新版本 SHA **保持不变**。

## 2. FolderPicker 统一资源位置选择器

### 2.1 用户流程
1. 发起：从 FileExplorer 选择单/多资源、目录操作、回收站恢复或上传目标。
2. 默认目标：可见且可选的当前文件夹或最近使用目标；UI 同时展示完整**有权可见**路径。
3. 浏览：层级树按需展开、搜索名称/路径；不可写目标显示不可选原因。
4. 候选：单击设置候选并显示来源/目标详细信息。
5. 预检：来源集合、目标 ID、目录代数、当前权限及源版本信息送到服务端；结果显示有效/冲突/不可操作及可能改变的继承权限。
6. 确认：仅在当前候选对应的最新预检 `ready` 时可提交；以幂等键提交实际写操作。
7. 结果：明确最终 committed、pending、conflict、failed，更新失效视图并恢复合理焦点。

### 2.2 状态机
| 状态 | 进入条件 | 主要 UI | 禁止条件/去向 |
|---|---|---|---|
| `initializing` | 打开 | 目录加载反馈 | 禁止提交 |
| `browsing` | 树可用 | 搜索/目录展开 | 切目标使预检失效 |
| `searching` | 检索输入 | loading/结果/空态/失败重试 | 不泄露未授权路径 |
| `candidate` | 选中候选 | 目标详情、来源/目标比较 | 非法目标禁止提交 |
| `validating` | 预检请求 | busy、可取消检索 | 旧响应不可覆盖新候选 |
| `conflict` | 服务端发现问题 | 冲突清单/修改目标/排除来源 | 不自动部分提交 |
| `ready` | 当前代预检通过 | 影响预览、确认按钮 | 权限变化则重新预检 |
| `submitting` | 用户确认 | busy、防重复提交 | 禁止静默取消服务端事务 |
| `succeeded` | 服务端 committed | 变更摘要、相关列表失效 | 刷新失败单独通知 |
| `failed` | 服务端拒绝或网络失败 | 稳定错误码、重试/查看当前状态 | 不猜测是否已提交 |

### 2.3 目录检索/性能协议建议
现有 `GET /api/folders/tree` 是整体可见树，前端 JSX 每层 `filter`。10k 目录目标建议按需查询：
- `GET /api/folders/children?parentId=...&cursor=...&limit=...`（新增提案；不得暴露不可见祖先）。
- `GET /api/folders/search?q=...&limit=...&cursor=...`（新增提案；路径仅含允许披露的信息）。
- 查询响应至少携带 `{id,name,parentId,hasChildren,canSelect,disabledReason?}`；`canSelect` 仅 UI 提示，事务还须重验权限。
- 可见树内存索引 `Map<parentId, Folder[]>`；展开状态以 ID 保存，超大列表按可见窗口虚拟化。

## 3. 文件/目录移动：端到端合同

### 3.1 业务决策（本草案建议值）
- 用户已决定桌面交互；**文件复制不在本期范围**（遵守 SPEC §9.4）。
- 单项与批量移动可统一目标选择器，但服务端执行必须区分文件和目录资源及权限。
- **批量首期全部成功/全部失败**：任一资源权限不足、重名或非法，commit 不改变任何资源；用户可主动排除问题项、重新预检。这是**新建议**，合并主 SPEC 前应由产品/后端确认。
- 非法目标包括自身、后代、无写权限目标、已失效或已删除目录、禁止的组织/项目边界。
- 预检仅作 UX，不是授权证明；提交必须在事务内重验来源 `move`、目标 `upload`、层级环、唯一名称、资源活跃状态。
- 成功保持稳定 file/folder ID、版本历史、内容哈希；新增审计事件、按现有权限 epoch 失效缓存并使搜索/收藏/共享范围重新计算。

### 3.2 新 API 草案（**不代表已经存在**）
为降低侵入，优先评估下列最小端点；批量实现前需 ADR 决定单次数据库事务可承受的上限。

**A. `POST /api/moves/preflight`**（推荐新增）
```json
{
  "resources": [{"kind":"file","id":"f_1"},{"kind":"file","id":"f_2"}],
  "targetFolderId":"folder_target",
  "mode":"all_or_nothing"
}
```
```json
{
  "ok":true,
  "data":{
    "status":"ready",
    "candidateRevision":"opaque-revision",
    "allowedCount":2,
    "conflicts":[],
    "warnings":["目标目录继承权限将重新评估"],
    "sourceSummary":"研发部 / 项目A",
    "targetSummary":"研发部 / 项目B"
  }
}
```
注：`sourceSummary/targetSummary` 必须经可见性过滤；不要将 `candidateRevision` 当作无需重验的授权 token。

**B. `POST /api/files/:id/move`**（推荐单文件端点）
```json
{
  "targetFolderId":"folder_target",
  "expectedFolderId":"folder_source",
  "idempotencyKey":"client-generated-opaque-key"
}
```
返回 committed 后的 `{fileId,fromFolderId,toFolderId}`；业务错误采用标准 `E_FORBIDDEN/E_NAME_CONFLICT/E_NOT_FOUND/E_MOVE_CONFLICT/...`；标准状态码 400/403/404/409/5xx 与统一 envelope。

**C. `POST /api/files/move-batch`**（推荐条件性新增，非首个实现先决）
```json
{
  "fileIds":["f_1","f_2"],
  "targetFolderId":"folder_target",
  "mode":"all_or_nothing",
  "idempotencyKey":"client-generated-opaque-key"
}
```
- 服务端先校验全部项目，事务内移动并写审计；最大批量数量必须显式规定；超出上限返回可理解错误。
- 同名冲突时返回逐项冲突**但不写入任何资源**；请求重复 replay 返回相同操作结果。
- 网络中断导致未知提交结果时，客户端使用幂等键重试或查询审计/操作状态，不重复生成变更。

**D. 目录移动：复用已存在 `POST /api/folders/:id/move`**
- 保持现有 API 兼容；如增加幂等性/预检，要保留旧行为或通过明示的契约变更处理。
- 目录后代成环由数据库/服务最终拒绝；大子树权限影响需要有界查询及审计，不把完整子树 JSON 推给浏览器。

以上端点的正式路径、schema、唯一约束、事务边界与缓存失效均需在开发前同步 `docs/SPEC-v2.1.md`、生成 `docs/openapi-implemented.yaml` 并新增正向/负向/并发/性能测试；不得只改 TypeScript facade。

## 4. 错误与异步操作基础合同

### 4.1 统一 API 客户端
```ts
interface ApiError extends Error {
  code: string;          // 例如 E_FORBIDDEN / E_NAME_CONFLICT
  httpStatus: number;
  requestId?: string;    // 如响应提供
  retryable: boolean;
}
```
- JSON 请求统一从 `shared/http.ts` 传输；非 JSON 上传以 `shared/uploadClient` 复用错误 envelope/会话/取消/trace 处理。
- `401` 使用全局 session 状态恢复/导航到登录，不把 401 文案伪装成业务冲突。
- `403/404` 避免区分无权限与不可见资源而泄露隐私，显示允许公开的泛化说明。
- `409` 应映射为可执行恢复动作（更换名称、刷新版本、重选目标、查看锁主）。
- 禁止异步请求以 `setMessage('成功')` 作为事务真相；只在收到确定的服务端结果后汇报。
- 使用 AbortSignal/generation 防止过期请求影响当前页面；对不可幂等写操作，Abort 浏览器请求**不意味着服务端已撤销**。

### 4.2 通用提交状态
`idle → validating → submitting → committed/pending/failed/unknown`。
- `unknown`：请求断连且无法确认是否提交，不盲目重做破坏性写入；通过幂等键与读取结果核查。
- 已完成写入但列表刷新失败：必须区分两个独立状态，“移动成功，刷新失败，可重试”。
- `pending` 用于审批受理/转换排队，不能显示“正式完成”。

## 5. UploadQueue
### 5.1 状态
每项：`queued→validating→uploading→server-processing→committed`，错误可以进入 `failed/cancelled/unknown`。
- `<input multiple>` 与 OS 拖放支持批量文件，每个文件有稳定 queueId、name、size、targetFolderId、idempotencyKey、progress、status。
- 允许设置并发上限（候选：2–3 条），大文件并发不得挤占一般交互；上限通过远端实际性能测试决定。
- 进度区分“浏览器已发送字节比例”与“服务端已提交”，不能发送完成 100% 就宣布上传成功。
- 原有 multipart 单请求服务端上传可以保留；**不宣称支持断点续传上传**。若需要准确发送进度，可使用经审查的 XHR 传输封装；并遵守 session/CSRF/错误协议。
- 用户取消只保证未提交请求的本地取消；如果请求已在服务端提交，必须查询结果确认，不能假称回滚。
- 同名冲突需要逐项可重命名/跳过/重试的决策；不能悄悄覆盖当前版本。
- 失败重试同一文件、同一内容和操作使用相同幂等键；用户修改目标/文件名后生成新的操作身份。

## 6. PermissionWorkspace
1. 主体切换“用户/工作组”必须分别调用真实数据源；当前 `Documents.tsx:41-51` 只载入 users，而 `GrantDialog.tsx:79-87` 有 group 选择，需修复数据源。
2. 服务端已可接收授权到期字段 `ExpiresAt`；前端新增可校验的有效期/时区输入，服务器负责最终过期判定。
3. 权限显示分为“直接授权”“继承授权”“最终生效能力”；最终授权来源若无服务端解释 API，不得靠客户端重新计算 ACL 冒充真实判定。
4. 修改权限前显示受影响文件夹与后代范围的**有界摘要**，越权时不泄露路径；敏感撤销加确认。
5. 撤权后立即刷新当前目录可见性、共享搜索、Inspector、状态缓存；本地已有选中资源失权即清理。
6. 在编辑器/Office 正在工作时发生失权，显示已保存状态与冲突处理，不把草稿错误归功于用户。

**按需新增端点候选**：`GET /api/folders/:id/effective-permissions?subjectKind=...&subjectId=...` 或面向当前用户的可执行动作描述接口；须明确 admin-only/授权边界。优先复用已有权限查询，避免制造不必要的新 API。

## 7. Version History + Rollback
- 版本表需要明确当前版本、版本生成原因、创建人、时间、源 SHA、目标 seq 与 `rollbackTargetSeq/rollbackFromSeq`。
- 单条历史版本支持查看元信息；回滚操作需 `reason`、`targetSeq`、`expectedCurrentSeq`、有效锁 `lockToken`、`idempotencyKey`，符合现有 `SPEC §9.5`。
- 预检显示“回滚将生成新版本，不删除历史”；审批目录 `202 pending` 显示“已提交待审批，当前生效版本未变”。
- 并发 CAS 冲突 `409` → 刷新版本信息并要求重新确认，不偷偷以旧基准覆盖。
- 获取锁失败/他人锁定时禁用回滚并提供有权限的恢复说明。

## 8. Trash Restore
- 默认尝试原位置恢复；源父目录不存在时调用 FolderPicker 选新位置；同名冲突时提供自定义新名称（仅在服务端允许时）。
- 目前 UI `trashApi.restore(id, "", "")` 不能完成这一交互，需要新的 Restore Dialog 状态机：`chooseSource → resolveParent → resolveConflict → confirm → submitting → committed/failed`。
- 恢复保持原对象 ID/版本历史；结果刷新目标目录、回收站列表和 Inspector。
- 永久删除若提供入口，必须 admin-only + 不可逆影响描述 + 二次确认；不悄悄添加非后端支持的能力。

## 9. Sharing/Favorites/Organization/Search/Stats/Approval
| 业务 | 目标交互 | 已知代码缺口 / 风险 |
|---|---|---|
| 分享 | 创建、按 user/group 选对象、权限动作/有效期/继承、确认/撤销 | `createShare` API 有，但 `CollaborationPanel` 主要展示/撤销 |
| 关注 | 文件/目录列表及 Inspector 中一键关注，统一状态同步 | `setFavorite` API 有，`CollaborationPanel` 仅取消关注 |
| 组织 | 部门树 + 工作组/成员详情 + 可搜索选择；危险管理操作模态确认 | `OrganizationPanel` 为平面用户表/工作组按钮；重置密码为 `window.prompt` |
| 搜索 | 查询结果稳定分页、可回到目录定位、可访问全文片段、真实授权结果 | `SearchPanel.tsx:49-60` 一次请求 50 条，未见分页入口；服务端能否 cursor 需单独核对 |
| 统计 | 由 FolderPicker 选合法文件夹/范围，应用筛选并同一过滤器导出 | `StatsPanel.tsx:32-34` 要用户手动输入 folder ID；旧统计失败后残留数据需处理 |
| 审批 | 每个决定输入意见，影响版本预览，提交互斥，409 重新加载 | `ApprovalInbox.tsx:68-70` 固定批准/拒绝意见 |
| CAD | 保留真实装配/材质，完善 viewer 状态栏与键盘作用域 | `ModelViewer.tsx` 现有真实能力，勿重写核心渲染器 |
| DOCX | 保留 ONLYOFFICE 外部编辑器，改善会话保存/关闭冲突说明 | `OfficeEditor.tsx` 当前 Shell 独立绘制 |

## 10. 实施隔离与 ADR 决策
- **最小改动优先**：视觉与交互先封装在 shared/ui、features 中；业务领域变更需有专门 ADR 和负向用例。
- 新端点前明确：文件移动是否首期 P0、批量提交上限、预检强制性、事务 all-or-nothing、状态查询/幂等键保留时长。
- 如果工期有限，先交付 Safe Editor / ApiError / FolderPicker / 单目录与单文件移动，再进行跨资源批量和高级拖放；不可做假按钮。
- 所有功能能力以用户权限与服务端返回为准；不可绕过审计、不可暴露私有目录路径。
- 只有远端 `/srv/filesmanage` 可执行构建、测试、部署；不改端口 8091、不复制 `.secrets/`。
- 严格保留 `app→pages→features→entities→shared`，共享控件不得反向 import 业务层；迁移旧页面逐个完成，不一次性推翻 CAD/Office 已测链路。

## 11. 运行证据要求
每个工作流至少提供：
1. API 请求/响应合同及 OpenAPI 变更（无密钥/正文/用户隐私）；
2. 一个成功、一个权限拒绝、一个冲突、一个重复提交、一个网络未知结果测试；
3. 浏览器实际鼠标/键盘操作证据，焦点与选择行为断言；
4. 数据库存储/版本/审计的事务一致性断言；
5. 远端 `scripts/build.sh --with-tests` 和必要专项测试的结果记录；
6. 本地/远端 commit SHA 对照（不将本地 clone 冒充远端最新快照）。

> 测试 ID 与退出门槛见 `UX-ACCEPTANCE-v1.md`。本合同列出的新增端点未经实现时只属提案，不得在交付报告中标记为已支持。
