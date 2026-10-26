# Knowledge Workspace V0.1 — 与 Finder 合一的知识页面工作区

日期：2026-10-25
实施分支：feat/dhf-v080-main-compatible
源码基线：已部署主系统 fda7a90，不覆盖原版 Finder 或登录资源
企业文件 / DHF / CDW 审批边界：沿用现行 ACL 与受控文件流程，知识页不具备发行/签批资格

## 本批交付

- 资源导航：原顶部“文档管理”改为“文件与知识”，合并独立顶栏知识入口；Finder 侧栏增加可展开页面树及子页面入口；文件夹标题出现知识首页入口，预览页有文件知识引用跳转。
- 独立知识页面：层级页面创建，标题编辑，正文/标题/清单/待办/引用六种内容块；支持拖拽移动和键盘插入；Markdown/外部 HTML 不注入页面。
- 可见性：页面拥有者或对其所在文件夹具有有效读取 ACL 的用户能查看；非页面拥有者不能编辑。文件引用进一步使用现有文件级 ActionPreview 权限（含直接分享），不能通过知识引用绕过受控文件的实际访问。
- 文件夹知识首页：独立 folder_knowledge_homes 一对一关系，**默认不创建**。需要已存在、当前 folder 内页面以及文件夹修改权限后显式绑定；可以解除绑定而不删除页面。项目模板自动创建仍为下一阶段，不能默认激活。
- 双向关联：独立 knowledge_file_refs（文件→页面）、knowledge_page_links（页面↔页面），关系变更独立记审计，解除引用不删除真实文件或知识页。
- 编辑追溯：revision CAS，创建保存 revision 1、修订后写入不可覆盖版本快照，阅读历史只读；不允许归档仍被设为首页或仍有子页面的页面。归档不物理删除历史。
- 数据库迁移：0093_knowledge_pages.sql、0094_knowledge_page_links.sql，对现有 94 项追加为 96 项，不改动原有 1–92 表/数据。
- 生成 OpenAPI：相应 GET/POST/PUT/DELETE，新增 15 个知识接口。所有读写要求原有 session 登录。

## 真实隔离验收

- PostgreSQL 17: 从原业务库备份恢复的独立 `filesmanage_knowledge_review_20261025`，用原应用账号执行 schema migrations 96/96 PASS。
- API：真实克隆业务账号管理会话；无身份 GET 401；知识页创建/子页/块修订/409 旧版本拒绝；修订 2/1 历史；手动绑定和解除首页、文件引用和反向引用、页面引用出入双向、拒绝自我关联/无效目标、归档限制及最终归档通过。全过程仅在隔离克隆库运行。
- 浏览器：独立候选 `127.0.0.1:18096`，真实 Chromium 已登录并确认编辑页面、历史版 UI、Finder 集成导航；1440/1024/760/390px 四档布局 PASS。
- 后端 `go test ./internal/... -count=1`、`go vet ./internal/...`、Go server build PASS。
- 前端 loading contract、TypeScript `tsc --noEmit`、Vite build（767 modules）、RareUI style 64、component 154 PASS。Three.js 大包 warning 仅警告。
- 原 Logo `logo-loader-256.png` 和登录背景 `login-showroom-bg.webp` 同现有业务前端 SHA-256 一致。
- OpenAPI generator check 262 paths / 312 operations PASS。保留已有 acceptance matrix 的 3 PARTIAL，不能冒充已全部完成。

## 设计/上线限制

本批并不是完整 Notion：尚没有项目模板自动生成知识首页、页面全文搜索、跨项目授权迁移、实时多人富文本 CRDT、数据库属性视图，以及 DHF Gate 文件审签中的页面冻结快照。特别是编辑只保证乐观锁 CAS，不声称多人实时无冲突编辑。

发布 Review 只对开发环境 `10.144.144.1:18091` 生效，生产 `8091` 不动。实施前对 filesmanage_v21 做全量 `pg_dump -Fc` 并校验；迁移只追加 0093/0094；新版本使用独立发布目录，旧构建与原文件数据不覆盖。回退仅停止新发布进程并重启原业务服务，数据库新增表保留，避免破坏记录。
