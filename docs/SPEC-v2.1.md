# SPEC v2.1 — 企业级文档管理与协作治理系统（第一期完整交付）
> 版本：v2.1-draft.6；日期：2026-10-08；状态：全新业务数据域已确定（DEC-15）；SQL/API/资产/引擎/性能验证仍未完成，正式 Build/上线 NO-GO。
> 上游：SPEC.md v2（416 行）；增补审查：SPEC-v2.1-CONTRACT-REVIEW.txt；视频证据：VIDEO-EVIDENCE-v2.1.txt。
> 核心架构：Go >=1.22 + Gin + PostgreSQL >=14（pgx/v5）+ React 18 + TypeScript + Vite + React Router Browser + Zustand。
> 交付范围：C01–C22 全部保留；首期追加真实 DOCX 在线编辑、正式品牌 Logo 与机械 CAD/3D 模型预览（C23–C25）。
> 部署意向：192.168.1.22:/root/repository77；端口 8091；systemd；正式替换旧服务之前必须隔离验证与可恢复备份。
> 公司主体：中晟生物科技；系统内用户展示使用岗位名；禁止把视频中外部公司与人物姓名写入正式种子。
> 说明：本稿是扩展型主规格草案，不覆盖原 SPEC.md。未标记完成的安全、迁移、验收条件不得省略。

---

## 0. 文档治理、证据优先级与定稿状态

### 0.1 适用范围和目标
本规范供产品、UI、Go 后端、React 前端、数据库、QA、部署工程师和开发 Agent 使用。
每条“必须”代表第一期交付阻断项；“建议”不自动成为硬约束；“待决策”在实施前需要签字确认。
功能“交付”定义为：界面入口、后端 API、数据模型、权限、错误处理、完整正反向测试、部署一致可用。
不得以“有页面但点不了”“按钮只弹出敬请期待”“只在内存中临时模拟”宣称完成。
不把旧 Node 冒烟 49/49 当成新 Go 系统通过验收的证据；它只是历史行为参照。
既定框架、数据库、路由和公司主体继续有效，除非用户明确改动。
第一期排除：LDAP/SSO、移动端专用适配、CAD 模型在线几何编辑或 DWG 写回、大规模审计 BI、匿名公网外链分享。**DOCX 原格式编辑后生成有效 DOCX 新版本，以及首期规定格式的机械模型在线预览，均为必须交付项。**
第一期包含：回收站、共享文档、我的关注、统计、导出列表、官方 Logo、在线 DOCX 编辑、常见机械 CAD 模型预览及原有权限、锁、版本和审批闭环。

### 0.2 唯一事实来源与冲突优先级
E1：[VIDEO] 原始 5m48s 视频的多时间点抽帧复核结果；尚未逐帧完整转录，未观察到的交互不推断。
E2：[IMG-A] 组织管理截图；[IMG-B] 文档管理截图；仅证明所在帧可见状态。
E3：[USER] 已明确第一期五项功能、Gin/PostgreSQL/React、岗位名、Logo 蓝白视觉（DEC-14）、真实 DOCX 在线编辑、机械 CAD 查看；新系统只用新 PostgreSQL、全新数据，不迁移 Node/SQLite（DEC-15）。
E4：[NODE] 原 Express/SQLite 的 API、数据形状、种子和 49 项冒烟。
E5：[SPEC-v2] 初始功能边界和旧 S1–S13。
E6：[DESIGN] 本规范新增且尚未获用户批准的专业设计提案。
优先级：安全/数据完整性约束优先；已明确的用户决策优先于旧代码；原视频可观察交互优先于主观猜想。
某需求如和旧行为冲突，必须登记“差异 ID、旧行为、新行为、用户裁决、回归测试”；不得静默改变。
旧代码中的越权授权、失效锁下直接保存、富文本样式假保存、危险 HTML 输出不列入“兼容”范围。

### 0.3 决策登记与开放事项
FIX-01：后端 Gin，数据库 PostgreSQL（pgxpool），前端 React 18 + TypeScript + Vite。
FIX-02：Browser Router；规范工作台 /doc、组织 /org、预览 /preview/:id。
FIX-03：公司名中晟生物科技；默认业务账号用岗位名；UI 图标全部内联 SVG。
FIX-04：采用 Logo 驱动的蓝白工业科技风，品牌亮蓝/深蓝、白底/浅蓝白、紧凑企业信息架构；黄色 SVG 文件夹作为语义标识。统一 tokens 和操作 SVG；不得混入外链 iconfont/CDN。
FIX-05：原 C1–C15 + 回收站、共享文档、我的关注、统计、导出列表，全部第一期完整交付。
FIX-06：用户提供的蓝色抽象标志是正式 Logo 唯一视觉原始依据；源图像资产须入库并校验，不可用其他图标占位交付。
FIX-07：首期必须能打开真实 DOCX、完成有效内容/格式编辑、将结果以可再次打开的 DOCX 文件签入新版本，并走锁/审批/审计。
FIX-08：业务场景以机械设计为中心；首期必须能在线查看格式矩阵内的主流中性模型和机械 CAD 文件，后端依赖必须通过样本验证。
RESOLVED-01 / DEC-14：用户最终确认“按照 Logo 的风格来”：以正式蓝色 Logo 为视觉源，采用现代蓝白工业科技风；视频只作为信息架构/功能/交互参照，不复刻旧式灰白皮肤。详见 §11.5。
RESOLVED-02：用户已明确选择真正的 DOCX 在线编辑与 DOCX 新版本保存。编辑引擎基线为自托管文档服务（优先验证 ONLYOFFICE Docs）；具体编辑工具栏的格式覆盖与兼容例外由 DOCX 合约和样本验收约束。
RESOLVED-03 / DEC-13：用户已选定 Append-only 回滚：保留全部历史，向版本尾部追加一个内容等于目标历史版本的新签入版本；严格禁止回滚时删除后续版本。
RESOLVED-04 / DEC-15：全新 PostgreSQL、BlobDir、账号、组织与业务演示数据；无旧 Node/SQLite 业务迁移。历史源仅隔离归档，未经另行授权不删除（§12.4、§14.4）。
OPEN-04 [P1] 支持旧截图路径 /organization?op=group 的兼容路由；建议支持。
OPEN-05 [P1] 第一阶段对 UTF-8 以外、混合行尾的文本只读而不破坏原文件；建议支持此保护策略。
OPEN-06 [P1] 文本相同仍显式点击保存时是否新增版本；暂遵循 v2“每次签入产生新版本”。
OPEN-07 [P1] 共享范围仅内部用户/工作组，匿名外链排除；若用户要求公网分享需另加认证和风控。
OPEN-08 [P1] 页面截图基准建议 1440×900、100% 缩放，补 1366×768 和 1920×1080。

### 0.4 质量门禁
G0：RESOLVED-01（品牌视觉）、RESOLVED-02（真实 DOCX）、RESOLVED-03（Append-only）、RESOLVED-04（新数据域）与机械设计范围均已确认；品牌原图、引擎许可/PoC、可执行新库 DDL/API 与测试契约仍为 Build 前门禁。
G1：静态 API/DDL/类型契约、权限矩阵、状态机、测试夹具冻结。
G2：最小服务可建库、登录、ACL、目录查询、Plain Text 预览和字节校验。
G3：编辑锁、审批、版本、回滚、文件上传/下载/检索完成且并发测试通过。
G4：五项首期新增功能，包含操作审计、负面用例、数据权限与回归测试。
G5：React 页面逐项验收，Browser Router 深链刷新通过。
G6：独立环境构建、冒烟、备份/回滚演练；获准后才在生产 8091 切换。
每个 Gate 有证据：提交哈希或目录快照、测试报告、失败数、环境、数据库 schema 版本、截图编号。
Gate 不允许以“Agent 觉得完成”替代证据。

---

## 1. 第一阶段产品能力矩阵

| 能力ID | 范围 | 最小可验收行为 | 对应页面 |
|---|---|---|---|
| C01 | 登录/会话 | 账号口令登录、有效期、注销和错误码 | /login |
| C02 | 部门层级 | 树形组织、选中状态、人员映射 | /org |
| C03 | 工作组 | 新建、成员加入、移除、管理权限 | /org |
| C04 | 文件夹 ACL | 9 种文件动作、明细、撤销、后端强制 | /doc |
| C05 | 权限继承/合并 | 父链继承、组/人并集、仅本目录 | /doc |
| C06 | 授权截止时间 | 到期即时失效、可控时钟验收 | /doc |
| C07 | 本目录仅限 | 授权不向子级扩散 | /doc |
| C08 | 文件操作 | 新建目录、上传、下载、预览、修改、删除、改名、移动 | /doc |
| C09 | 多格式预览 | DOCX、mp4、图片、PDF、文本、CAD 格式按能力矩阵预览 | /preview/:id |
| C10 | 在线编辑 | Plain Text 字节保真与真实 DOCX 在线编辑/回写、锁与审批联动 | /edit/:id |
| C11 | 协作锁 | 冲突、超时、续租、可见锁主 | /edit/:id |
| C12 | 版本控制 | 上传 v1、保存签入、不可变完整历史、Append-only 回滚、并发冲突保护 | /versions/:id |
| C13 | 搜索 | 中文全文、摘要、权限过滤、部门和人员过滤 | /search |
| C14 | 审批工作流 | 规则生效、待审、同意、拒绝、版本落地 | /approvals |
| C15 | 企业品牌 | 公司主体、品牌信息、岗位身份和 SVG | 全站 |
| C16 | 回收站（首期新增） | 软删除、浏览、恢复、永久删除、权限审计 | /trash |
| C17 | 共享文档（首期新增） | 内部定向分享、共享列表、详情、撤销、权限生效 | /shared |
| C18 | 我的关注（首期新增） | 收藏/取消文件和文件夹、列表、跳转、失效展示 | /favorites |
| C19 | 统计（首期新增） | 可访问文件范围的数量、容量、类型、时间分布 | /stats |
| C20 | 导出列表（首期新增） | 授权过滤、与筛选一致的 CSV、可安全用 Excel 打开 | /doc、/search、/shared |
| C21 | 系统管理 | 用户、工作组、部门、角色管理基础功能 | /users、/org |
| C22 | 可靠交付 | 新 PG schema migration、受控首装初始化、持久化、systemd、隔离验证与恢复；不做旧 SQLite ETL | 后台 |
| C23 | 官方 Logo | 以用户提供的蓝色标志为唯一品牌源图，完整生成站内适配资源 | 全站 |
| C24 | DOCX 原格式编辑 | 自托管编辑引擎、真实 DOCX 回写、版本/审批/锁/兼容验证 | /edit/:id |
| C25 | 机械模型在线预览 | STEP/IGES、网格模型、DXF/DWG 图纸、装配视图与权限版本 | /preview/:id、/model/:id |

### 1.1 第一阶段验收原则
每个 C 项同时包含 Happy path、越权路径、无数据路径、失效路径、浏览器刷新路径与数据库断言。
任一 C16–C20 缺少有效数据持久化或服务端权限校验，即判该能力未交付。
“共享”和“关注”是用户维度的数据；“统计”和“导出”必须依照调用者实际可见范围计算。
不允许开发者用管理员身份测试通过后省略普通员工视角。
删改文件和批量操作必须显示明确目标数量、失败项和不会误导的结果。
当前版本以单公司为产品域；后续多租户架构不是本期暗含目标。

---

## 2. 角色、组织、权限与安全域

### 2.1 身份和角色
系统管理员：admin 角色，可配置全公司基础结构、用户、组、顶层目录和全局业务策略。
部门管理员（可选配置）：由 admin 授权某部门的用户/组管理；不可自动管理其他部门。
目录所有者：创建者或明确指定的 owners；可管理自己拥有且未被系统策略剥夺的资源。
普通成员：按 ACL 与内部分享确定文件动作；不因上传文件或能看到文件名获得全部管理权限。
审批人：对指定审批单有决定权，不因此获得无限下载或跨部门浏览权。
工作组：不是登录身份，是权限和共享授权的主体；用户可同时属于多个组。
岗位名是展示策略，用户唯一 ID 与权限身份不依赖名字，改名不影响授权。

### 2.2 9 种可见文件动作
list：查看目录列表及可显示的目录导航。
preview：查看预览内容或允许的播放流。
upload：在指定目录创建新文件或向目标目录移动文件。
download：显式下载二进制内容。
modify：进入允许的编辑流程；仍需协作锁及 base_version。
delete：把可见文件/有相应管理权的子目录移入回收站。
rename：重命名文件或授权范围内目录。
move：移动文件；源需 move、目标需 upload、目标必须存在且未删除。
print：界面提供打印控件（仍须 preview）；打印不是绕过预览权限的独立下载。
额外管理能力不放入视频九宫格：manage_acl、manage_share、manage_folder、manage_approval、purge_trash、manage_users、manage_groups、view_audit。
不得把任何管理能力隐式映射成“有 list 就可以做”。

### 2.3 基础授权算法
输入为 userId、resourceId、requestedAction、time；输出 grant/deny + reason 和可审计的来源。
获得用户所属工作组集合、所在部门及系统角色；读取目标目录祖先链（自根到当前），拒绝环和不存在的祖先。
忽略已过期记录，scope_only 仅作用于 ACL 所在目录；用户授权和组授权动作取并集。
对文件动作先解析所属目录，有效目录 ACL 与文件级分享授权另按共享策略计算。
admin 默认具备管理业务资源的权限，但仍需操作日志、危险动作确认、锁/版本完整性校验。
“隐式管理员免权限”不能豁免写版本的 CAS、数据库约束、病毒/文件格式检查。
账户冻结或会话被吊销时，即使浏览器还缓存按钮，也必须拒绝。
权限变更后立即影响新请求，长时间打开的编辑界面保存时必须重新校验。
过期时间采用服务器 UTC epoch ms；边界 now >= expires_at 判过期，不把前端时钟当授权来源。

### 2.4 共享授权与原 ACL 的关系
本期仅支持登录后的内部用户/组分享，不支持匿名公网下载 token 链接。
共享对象可以是单文件或文件夹；文件夹分享可指定 include_descendants。
共享动作仅允许 list、preview、download 的子集；不得通过普通共享赋予 modify、delete、manage_acl。
分享者必须是 admin、资源所有者，或被明确委任 manage_share；
且普通分享者只能授予其自身具有的读取/下载动作，不能权限扩张。
分享允许跨部门可见，但只显示被共享对象的最小必要路径信息；不打开无权祖先目录。
从共享列表进入资源时使用安全虚拟路径上下文，不让侧栏泄漏其他目录。
用户或组共享与目录 ACL 作正向并集；撤销分享只撤销该分享来源，不误删原有 ACL。
被共享的目录删除/过期/迁移后不继续暴露已删除内容。
被分享文件的创建者、历史上传人等元数据可见性需受业务规则约束，敏感字段默认最小化。
支持 expire_at；过期分享自动失效，不需要依赖浏览器定时器。
共享可见不等于允许再次转分享；再次分享仍需 manage_share。
共享对象在共享页和文档页不得形成权限检查不一致的两条代码路径。

### 2.5 授权操作安全
POST/DELETE ACL 必须要求 manage_acl；默认仅 admin，普通人授权按后续管理角色设置。
新增/修改共享必须 require_manage_share，不能只 requireAuth。
新建目录必须具备 manage_folder 或明确定义的 create_folder 能力，不能只有 list。
返回 ACL 明细时需要管理能力；普通员工只可查询自身 effective actions，不可任意列出他人 ACL。
资源不存在与无权访问的错误信息应避免成为对象枚举渠道；必要时统一返回 404。
跨用户权限测试要同时验证 HTTP 状态、响应体、数据库零变动及日志事件。

### 2.6 授权审计事件
登录成功/失败、注销、创建/撤销 ACL、创建/撤销共享、删除/恢复/清空回收站、
提交/批准/拒绝审批、保存/回滚版本、管理员创建/冻结账户都记审计事件。
审计最少字段：actor_id、event_type、resource_kind、resource_id、before_json、after_json、
request_id、created_at、outcome、ip_hash 或经过隐私处理的来源、原因。
安全拒绝也应记录可追踪事件；不得在日志里保存文件全文、口令、sid、原始 cookie。

---

## 3. 信息架构、导航与页面文字规格（Plain Text-A）

### 3.1 截图证据范围
组织管理截图：[IMG-A] /organization?op=group，顶部状态栏、品牌导航、左树、右成员卡。
文档管理截图：[IMG-B] 顶部导航、左文件夹树、右工具栏与文件表、统计和导出入口。
视频字幕、播放器控件、浏览器工具栏不是应用 UI。
截图可确认菜单名称、内容关系、当前选中高亮；不可反推全部业务弹窗或精确 CSS 像素值。
不复制演示中的 Company Name、人员姓名或文件名；实际数据按中晟生物科技 seed。
与演示视频的视觉差异已经由 DEC-14 裁决：视频的传统灰白界面只作为布局/操作流程依据；新系统统一按蓝色 Logo 的现代蓝白工业科技风设计，详见 §11.5。

### 3.2 公共 Shell
全局区域：**用户提供的正式蓝色 Logo**（经入库的本地位图或获确认的矢量衍生物）、中文产品名、用户身份/退出、一级导航、全局搜索。不得以通用云朵 SVG 代替正式 Logo。
一级导航满足：文档管理、上传、搜索、工作中心、组管理、系统管理、帮助；
可按 React 信息架构归并，但本期“共享文档/我的关注/回收站”要有明确可达入口。
页脚品牌：中晟生物科技 · 文档管理系统。
左侧纵向导航：我的文档、共享文档、我的关注、回收站、审批中心（带待审数）；
管理员增加组织管理、用户管理、统计入口。
主区顶部保留当前操作工具栏与面包屑；选择变化、路由变化及权限变化立即更新。
一级菜单在桌面宽度不足时允许折叠，但不得静默丢弃“统计/导出”等首期能力。
导航支持键盘 Tab、Enter、Escape、明显 focus ring、按钮 aria-label。
会话失效保留当前目的 URL，跳 /login，登录后回到有权访问的原目标。
404、403、空数据、网络错误、操作成功、锁冲突、待审批状态都有独立 UI 反馈。

### 3.3 路由表
/login                    登录和未授权引导。
/doc                      我的文档默认工作区。
/doc?folder=:id           指定目录，面包屑和文件表更新。
/organization?op=group    [建议兼容] 视频组管理入口，映射到 /org 的组模式。
/org                      部门、组树、右侧成员卡及管理工具栏。
/users                    用户管理（权限限制）。
/preview/:id              多格式预览和文件基本元数据。
/model/:id                机械模型/图纸专用预览页（也可由 /preview/:id 按 kind 跳转）。
/edit/:id                 协作编辑与保存。
/versions/:id             版本历史、历史版本详情和回滚确认。
/approvals                我待审/我发起，审批状态和详情。
/search                   全文检索、过滤器、摘要高亮。
/shared                   与我共享/我发出的共享两个 tab。
/favorites                我关注的文件/目录、取消关注和打开。
/trash                    回收站，列表、恢复、永久删除。
/stats                    文件使用统计，按权限范围过滤。
/404                      前端未知路径；非 API GET fallback 到 SPA。
所有路由刷新与深链直访都能工作；后端 /api/* 404 不被 SPA fallback 吞掉。
浏览器前进后退恢复目录、关键词、tab、筛选和分页的稳定状态，不依赖不可见全局缓存。
URL 中的 file/folder/user id 不能直接暗示访问权限；每个 API 独立校验。

### 3.4 组织/组管理页面
左树显示中晟生物科技根、部门及组；当前组有明显选中高亮。
左工具栏可见：新建、重命名、删除、授权、组详细、菜单；
权限不足时禁用并解释原因，或不渲染受限项。
右工具栏：菜单、查看共享、新增、详细、从该组移除。
右侧人员卡：岗位头像 SVG、岗位名、用户 ID、部门、选中态；不得硬编码三个人。
选择组 -> 右成员数据同步变化；取消或多选成员改变“移除”可用性。
新建组输入组名及所属部门，重名策略由服务器规定；非法部门/重复 ID 明确错误。
添加成员支持搜索/多选，重复添加幂等；移除最后成员后卡片显示空态。
组与部门可以关联但不能误认为同一对象；组改名不会改变成员和 ACL 的主体 ID。
非管理员进入管理页面返回 403/导航不可见；直访和 API 分别测试。

### 3.5 文档工作区页面
左树支持展开折叠、键盘选择、目录高亮、拖拽目标提示（不启用不可靠静默移动）。
当前目录右上有面包屑、统计和导出列表操作入口。
右工具栏可见：菜单、查看、新建文件夹、上传、下载、预览、修改、删除、
重命名、详细、移动、搜索、版本；按钮根据选择数和权限更新。
表格列至少为：选择框、文件名、大小、上传人、修改日期；可另提供操作列和锁状态。
文件名要显示 SVG 类型图标；文件类型黄/蓝等视觉规则沿用设计 token。
提供按名称、修改时间、大小排序；默认修改时间降序；排序与导出一致。
空目录有明确空态、上传入口只对有权限者出现；无权限目录不能闪现旧数据。
切目录/切账号时取消旧异步请求或校验 request key，不允许旧响应覆盖新目录。
批量删除/移动/下载分别明确部分成功策略；批量失败要返回成功数和失败项。
文件夹创建/删除/移动要防目录环；有锁、pending 审批、正在清理时给出冲突原因。
文件详情显示上传人、文件大小、扩展名、最近修改、版本和授权可见范围。

### 3.6 预览、编辑、版本与审批页面
预览顶部显示名称、大小、当前版本、最近修改、锁主警示、允许的操作。
DOCX 按段落和标题渲染，无权下载时不能提供显式下载按钮；
文本按原文安全呈现；视频/图片/PDF 从安全原始流读取。
编辑必须先取锁，再按所持权限进入相应编辑模式；
锁冲突显示谁在编辑及可查看的已签入版本。
版本表显示 seq、日期、大小、操作人、动作、状态和受控回滚入口；
回滚必须二次确认，明确提示“将所选历史版本内容复制成一个新的当前版本；所有已有历史继续保留”，并展示目标 seq、预计新 seq 和审核要求。
审批中心分“待我审批”“我发起的”，显示文件、申请人、审批人、当前状态、
申请时间和被保护的基础版本；只有指定审批人/admin 能操作。
审批提交后申请人可见状态，锁规则与最终版本生效必须一致。

### 3.7 回收站页面（新增）
提供“我的删除记录”与“我有权限恢复的资源”视图。
列表列：类型、名称、原位置（必要时脱敏）、删除人、删除时间、大小、包含子项数、状态。
支持按文件/文件夹、删除时间、删除人筛选；默认最近删除优先。
单条和多条恢复；管理员可执行永久删除；普通用户需要符合原目录授权和恢复策略。
回收站和活动目录采用清晰不同的样式；已恢复对象不应继续显示在列表。
文件夹软删除显示为一条可恢复项，子项不应作为多条可重复恢复的独立根操作。
恢复操作显示目标位置、同名冲突和是否存在父目录；必要时选择有权目标目录。
永久删除必须输入确认或二次弹窗；成功后不可通过普通 UI 恢复。

### 3.8 共享文档页面（新增）
两个 tab：“与我共享”“我共享的”；支持文件/文件夹类型筛选、来源用户、到期状态。
共享列表包括资源名、类型、分享人/接收方、权限、创建时间、截止时间、操作。
收到的共享可预览、按授权下载、打开分享文件夹；无权时显示可理解错误。
发出的共享可查看接收对象、权限、是否过期、撤销或调整授权（需 manage_share）。
共享对话框先选对象，再选内部用户/组、预览/下载动作、可选截止时间；
展示最终权限预览，防止授予分享者自己没有的动作。
无任何共享时显示空态和明确解释，不显示未经授权的他人记录。
共享撤销或过期后列表状态及时变化；已打开标签再次请求须重新鉴权。

### 3.9 我的关注页面（新增）
可以对文件和文件夹点击“关注”；再次点击“取消关注”，需幂等处理。
个人关注列表按最近关注时间倒序，显示资源名、类型、当前可见位置、关注时间。
点击资源按其原类型进入目录/预览；如果已软删除或权限失效，显示不可访问原因。
用户只能管理自己的关注；无法关注完全无权查看的资源。
跨目录搜索和分享页均可展示当前用户的关注状态，但一处变更其他处须刷新。
同一用户同一资源不能重复创建关注记录；取消后允许重新关注。

### 3.10 统计页面与列表导出（新增）
统计顶部提供范围选择：当前目录、包含子目录、我可访问的全部资源；
按类型、部门、上传人、时间筛选，所有过滤在服务端复验授权。
最低统计指标：文件数、目录数、当前版本总字节数、最近 30 日新增文件数、
按扩展名/类型的数量与容量、按月份的新增趋势。
统计排除回收站和无权访问的文件；管理员可选择全公司视图；
普通员工不可推断其他部门保密文件数量或大小。
当前范围和过滤条件清楚显示；空范围显示零和“暂无数据”。
“导出列表”导出当前列表/筛选后的全部授权结果，默认 UTF-8 BOM CSV，
RFC 4180 引号转义与换行保真，中文 Excel 可打开，Excel 公式注入必须中和。
文件列表导出字段：文件名、完整可见路径、大小（字节）、上传人、修改时间、
扩展名、版本号；不得包含 blob 路径、原始存储路径、他人 ACL 机密信息。
可选择“仅选中行”或“当前过滤全部”；导出前显示预计记录数及范围；
大结果需流式分批，不能将整个文件和所有行堆入浏览器内存。
导出本身需要 export_list 或等效受控策略；默认拥有 list 可导出元数据，
但不能把 download 权限偷渡为任意文件内容下载。
本期不要求生成 XLSX/BI 报表；CSV 是完整可操作的“导出列表”交付格式。

---

## 4. 视频时间轴证据与功能边界对齐

详细逐时间轴记录见项目根目录 `VIDEO-EVIDENCE-v2.1.txt`。其方法是对 05:48 原视频作多时间点画面抽查，不能替代逐字音频转录；精确标签待复核的地方不得创造原视频没有的表单字段。

| VIDEO ID | 大致区间 | 可核实主题 | 验收关联 |
|---|---|---|---|
| V-ORG | 00:20–00:47 | 组织工作组、授权成员、组成员卡 | C02、C03 |
| V-ACL1 | 00:47–01:23 | 文件夹操作与基础权限继承 | C04、C05 |
| V-ACL2 | 01:23–02:07 | 直接用户授权叠加、仅本目录与截止时间 | C05–C07 |
| V-SHARE | 02:07–02:20 | 共享文档区域可见 | C17 |
| V-PREVIEW | 02:20–02:31 | 多页文档阅读视图 | C09 |
| V-UPLOAD | 02:31–02:47 | 文件列表及上传文件交互 | C08 |
| V-VIDEO | 02:47–02:59 | 视频播放器预览 | C09 |
| V-EDITOR | 03:00–03:15 | 带 Ribbon 的在线编辑界面 | C10 |
| V-LOCK | 03:15–03:45 | 其他用户查看已签入版本、锁标识、放锁 | C11 |
| V-VERS | 03:45–04:10 | 视频中的历史版本及破坏性回滚提示（新版按 DEC-13 改为追加式） | C12 |
| V-SEARCH | 04:10–04:25 | 全文检索 | C13 |
| V-BUDGET | 04:25–05:02 | 项目预算、修改、锁状态 | C14 |
| V-APPROVAL | 05:02–05:34 | 审批工作流与决定弹窗 | C14 |

### 4.1 不允许用“看见界面”代替后台保证
视频显示锁标识，不代表自动证明锁的原子性；视频显示审批成功，不代表证明幂等。
视频展示富文本式编辑外观，不代表已经证明 DOCX 二进制回写。
视频能显示共享入口，但不能证明匿名外链、共享过期、撤回、组身份的完整实现。
视频确实显示版本回滚“删除此后的历史”；这一句只作为视频事实记录。用户已通过 DEC-13 明确选择不兼容该破坏性操作：新版只追加新版本、完整保留历史。
视频截图中浏览器地址、播放器进度条与宣传字幕均不是产品内组件。
未显示到的回收站恢复、关注/取消关注、统计和导出操作是第一期用户新增要求，标注 [NEW-P1] 而不是 [VIDEO]。

### 4.2 复刻判定与差异处理
每个场景必须具有三层验收：视觉区块与文案 → 前端交互 → 数据和权限的后端结果。
具有相同按钮名但没有真实持久化不合格；后端行为正确但缺少关键引导/状态反馈也不合格。
如果第一期新增功能与原视频不一致，以已经确认的新增范围为准，在差异记录里标为 intentional。
涉及安全的有意识差异默认接受“更严格的权限和错误处理”，但须保留用户可以理解的提示。
视觉设计以用户确认的主题决策为准，不冒称原视频 CSS 像素一致。

---

## 5. 技术架构、项目结构与编译契约

### 5.1 服务边界
唯一后端 HTTP 服务 Gin，监听 0.0.0.0:8091，由 systemd 托管。
PostgreSQL 使用 pgxpool，进程初始化时 Ping 数据库，失败退出并输出无秘密信息的诊断。
文件二进制采用服务器受控 blob 存储，不以用户传入的文件名直接作为实际磁盘路径。
前端 React 18 TypeScript 与 Go JSON API 同源，使用安全 httpOnly Cookie。
生产业务流程不依赖 CDN、第三方登录、公共在线预览 API 或云端 OCR。
数据内容和元数据应持久化，重启服务后所有回收站、共享、关注、审批记录仍可读。

### 5.2 推荐目录（不要求模仿旧 Node 结构）
```text
cmd/server/main.go
internal/config
internal/database         pgxpool、事务封装、迁移历史
internal/domain           类型、权限动作、状态机常量
internal/store            SQL 查询和写入，仅依赖 domain
internal/service          业务事务、blob staging、ACL、审批、回收站、共享
internal/httpx            Gin routes、middleware、handler、error response
internal/auth             scrypt、cookie/session
internal/blob             content-addressed or version-named blob、GC
internal/search           UTF-8 提取、spaced FTS、安全摘要
internal/docx             docx 渲染与正文提取
internal/seed             测试场景初始化
migrations                带版本号的 SQL 迁移
web/src/core              fetch、Zustand、format、icons、router
web/src/components        文件表、文件夹树、对话框、编辑器、预览
web/src/pages             登录、目录、组织、用户、回收站、共享、关注、统计
web/src/styles            tokens、base、layout、components
internal/webassets/dist   构建时复制的 Vite dist（由所属 Go 包 embed）
scripts/contract          API 合约、角色/权限/字节样本
scripts/e2e               浏览器回归测试
docs                      决策日志、视频证据、部署运维与回滚
```
注意：Go embed 不支持在 package 目录外向上跨目录寻找文件；需要通过明确构建阶段把静态文件复制到可嵌入目录。
生产 embed 内容只能包含已构建的前端 assets；不要在有缓存的情况下嵌入旧版 bundle。
本项目目前根目录是非 Git 注册工作区；实施前必须建立可恢复的代码快照/版本控制基线，不得仅靠“原样保留”口头声明。
架构分层完整强制规则见 §23（以其依赖图为权威），§5.2 目录仅为推荐项目路径；未通过 import/AST 门禁不得宣布架构合格。
所有写数据库的业务事务必须由 service 发起，store 方法接收显式 Tx/Querier，不得内部偷偷新开连接逃离事务。
BlobStore 是文件持久化抽象，不将完整大文件 Buffer 在多个 service 层复制多次。

### 5.3 API 响应和可诊断性
JSON 成功格式：`{"ok":true,"data":...}`，失败格式：`{"ok":false,"error":{"code":"...","message":"...","requestId":"..."}}`。
常用状态码：400 格式错误；401 未登录；403 无授权；404 隐藏式资源不存在；409 版本/锁/审批冲突；
413 超限；415 不支持的内容格式；422 结构合法但业务规则不允许；429 限流；500 服务错误；503 依赖不可用。
错误 code 可维护机器枚举：E_AUTH、E_FORBIDDEN、E_NOT_FOUND、E_BAD、E_LOCKED、
E_VERSION_CONFLICT、E_APPROVAL_PENDING、E_TRASHED、E_SHARE_EXPIRED、E_NAME_CONFLICT、
E_TEXT_ENCODING、E_PAYLOAD_TOO_LARGE、E_NOT_EDITABLE、E_DEPENDENCY。
为兼容旧调用，原 E_LOCKED/E_APPROVAL_PENDING/E_BAD 含义不作无声变化。
Request-ID 写入服务端请求日志并在错误响应附带，日志严禁输出 session、密码和整个数据 URL。
JSON 时间戳以 Unix epoch 毫秒呈现；列表分页使用明确 total、pageSize、cursor 或 page，不能混用不同字段含义。
原 API 路径、请求体、关键响应字段以原 SPEC §5 为迁移基线；新增字段须向后兼容。

---

## 6. PostgreSQL 数据契约

### 6.1 数据类型和完整性总则
资源主键可沿用字符串 ID 兼容旧前端，但所有主键非空、长度受限、碰撞失败，不用可猜测姓名作 ID。
用户、组织、目录、文件、版本、共享与关注均有 created_at/updated_at；统一 timestamptz 存储，
如对旧 API 需要毫秒 epoch 则转换在 transport 层；不能在应用内部混用秒和毫秒。
检查约束：非空名称、长度、无控制字符、状态枚举值、非负尺寸、seq>=1、合法到期时间。
对外永远返回 logical id 而非 blob 绝对路径；文件路径用于内部存储，不允许浏览器指定。
所有关联关系必须声明 FK 与 ON DELETE/RESTRICT 语义；关联删除不能依赖“调用方总会按对的顺序删除”。
在删除内容、审批和回滚时，记录需要保留的审计信息与可逆生命周期。

### 6.2 用户与组织
`users(id PK, display_name, pass_hash, dept_id FK NULL, is_admin BOOLEAN, disabled_at, created_at, updated_at)`。
`departments(id PK, name, parent_id FK self NULL, created_at, updated_at)`，防止父链成环。
`groups(id PK, name, dept_id FK NULL, created_at, updated_at)`，同部门下重复名称策略明确。
`group_members(group_id FK, user_id FK, created_at, PK(group_id,user_id))`。
`sessions(sid_hash PK, user_id FK, created_at, expires_at, revoked_at, last_seen_at)`；只存 session 摘要更优于明文 sid。
`roles/role_grants` 用于管理能力，若当前仅 admin/owner，也要保持可向部门管理员扩展的权限映射。
新建用户/组会验证部门存在；冻结用户应立即中止活跃会话，并使其共享与编辑资格失效。

### 6.3 目录与文件生命周期
`folders(id PK, name, parent_id FK self NULL, created_by FK, owner_id FK,
  requires_approval BOOLEAN, approval_policy_id FK NULL, created_at, updated_at,
  deleted_at NULL, deleted_by FK NULL, trash_root_id NULL)`。
`files(id PK, folder_id FK, name, uploader_id FK, created_at, updated_at,
  deleted_at NULL, deleted_by FK NULL, trash_root_id NULL,
  current_version_seq INTEGER, lifecycle_state)`。
生命周期建议 ACTIVE -> TRASHED -> PURGED。ACTIVE 文件关联的父目录必须 ACTIVE。
目录被软删时其整个子树按祖先墓碑语义不可见，但数据库原 parent_id 不破坏；恢复子树后重新计算可访问权限。
不同文件夹可以同名；同一目录中重复文件名是否自动重命名、拒绝或允许，需要固定策略。
本草案建议普通创建时同名拒绝 409，导入/批量上传时可显式选择“重命名后上传”。
资源移动时校验不能形成目录环，且有足够的目标 ACL；处于 TRASHED/PURGED 时不可被直接修改。
同一个 file id 的版本历史在跨目录移动后依然保持，不生成伪新文件。

### 6.4 版本、Blob、文本索引（Append-only 不可变历史）
`file_versions(id PK, file_id FK, seq INT, size_bytes BIGINT, sha256 CHAR(64),
 created_by FK, created_at, action CHECK(upload/edit/rollback/restore),
 blob_id FK, base_seq INT NULL, rollback_target_seq INT NULL,
 rollback_from_seq INT NULL, reason TEXT NULL, UNIQUE(file_id,seq))`。
已签入版本的内容、blob、动作、提交人与编号不可变。禁止使用 DELETE/UPDATE 已签入历史来实现回滚。正式物理销毁仅可遵循单独的永久删除与保留策略，留存审计。
rollback 版本的 target/from 必须非空，其他动作两者为空；目标与来源均属于同一 file_id，使用复合外键或等价数据库约束，禁止跨文件引用。
`blobs(id PK, storage_key UNIQUE, sha256, size_bytes, status CHECK(staging/ready/gc_pending), created_at, last_verified_at)`。
`files.current_version_seq` 由同文件行锁与事务串行化更新；新增签入版本一律分配 MAX(seq)+1（或受同样串行化保护的单调 next_seq），包括回滚、审批后回滚、编辑和恢复签入。严禁重用旧 seq。
允许多个签入版本引用同一不可变 blob（内容相同）；GC 必须检查所有版本和审批引用，不能删除仍被历史使用的 blob。
`file_text(file_id PK FK, current_seq, text, spaced, tsv GENERATED STORED, indexed_at)`。
当前索引/下载/媒体/DOCX/模型派生均对应 files.current_version_seq；待审 payload 不进入普通全文索引和预览。文本索引的正规化不能改变源字节。

### 6.5 ACL、内部共享、关注
`acls(id PK, folder_id FK, subject_kind, subject_id, actions JSONB, expires_at,
 scope_only BOOLEAN, granted_by FK, created_at)`。
建议使用 CHECK 限定 actions 白名单；由 service 验证主体实际存在，
必要时拆分 user_actors/group_actors 关联表以保留 DB FK 完整性。
`shares(id PK, resource_kind CHECK(file/folder), resource_id, recipient_kind CHECK(user/group),
 recipient_id, actions JSONB, include_descendants BOOLEAN, expires_at, revoked_at,
 created_by FK, created_at, updated_at, message NULL)`。
share 唯一键建议约束资源+接收方+来源+有效窗口；禁止同一管理员重复提交创建重复活跃记录。
分享状态派生为 active/expired/revoked/resource_deleted/recipient_disabled；
“到期”按当前服务器时间查询，不依赖作业定时更新。
`favorites(id PK, user_id FK, resource_kind, resource_id, created_at,
 UNIQUE(user_id,resource_kind,resource_id))`。
关注属于个人元数据，不赋予额外读取权限；受关注资源删除或失权后列表按隐藏策略处理。
如果使用多态 resource_id 字段难以创建普通 FK，则需要 trigger 约束、分表 FK 或一致性检查任务；
不能写一条无法保证引用完整性的泛型表后宣称“有外键保护”。

### 6.6 回收站、审批、锁和审计
`trash_entries(id PK, root_kind CHECK(file/folder), root_id, original_parent_id,
 original_name, deleted_by FK, deleted_at, purge_after NULL, restored_at NULL,
 purged_at NULL, snapshot_json)`。
子目录级联软删除只生成一个可恢复根记录；恢复遇重名/祖先已删除时必须选择并审计解决策略。
`edit_locks(file_id PK FK, user_id FK, token_hash, acquired_at, renewed_at,
 expires_at, base_seq)`。Token 只给持锁用户，数据库存 token hash。
`approval_policies(id PK, folder_id UNIQUE FK, approvers JSONB, enabled BOOLEAN,
 created_by FK, updated_at)`，沿祖先链查找最近有效规则。
`approvals(id PK, file_id FK, requester_id FK, assigned_approver_id FK,
 action, payload_blob_id FK, base_seq, status, created_at, decided_at,
 decision_note, decided_by FK NULL)`。
pending / approved / rejected / cancelled / conflicted 是推荐状态值；
审批决定需要数据库 CAS 和冲突前置检查。
`audit_events(id PK, actor_id NULL, event_type, target_kind, target_id,
 request_id, status, old_json, new_json, created_at)`。
`schema_migrations(version PK, checksum, applied_at)`；执行时数据库级排他锁和 checksum 验证。
以上是**逻辑模型**，不是无需进一步检查即可运行的完整 SQL DDL。
所有子系统进入 Build 前必须生成经过 PostgreSQL 语法验证、互相一致的 migration SQL。

### 6.7 索引和查询安全
文件 `(folder_id, deleted_at, updated_at)`、版本 `UNIQUE(file_id,seq)`、
审批 `(assigned_approver_id,status,created_at)`、分享 `(recipient_kind,recipient_id,revoked_at)`、
关注 `(user_id,created_at)`、审计 `(target_kind,target_id,created_at)`。
全文 tsvector GIN 索引；文件名如独立检索，可建立适当索引或在可控结果集上筛选。
所有列表 SQL 必须限制结果大小/分页，不能先无限提取公司全部内容再在浏览器过滤权限。
运行统计时以可访问资源关系为输入，不能先聚合秘密数据再只隐藏明细。
索引更新、版本更新、软删除在同一业务事务边界内确定可见性。
FK 的级联规则与软删除不混淆：不应使普通软删除触发物理删除历史版本和审计。

---

## 7. 核心状态机、并发与业务原子性

### 7.1 文件上传
前提：已登录、目标目录 ACTIVE、拥有 upload、总量/扩展名/类型和名称合法。
上传可选单个/多个文件和拖拽；保持旧 dataURL API 兼容，但对大文件增加 multipart streaming。
每个文件从请求接收 → staging blob → 校验大小及 checksum → 文件+版本 v1 DB 事务 →
索引安排/提交 → ready 可见。失败必须提供明确每个文件结果。
客户端重试携带 idempotency_key，避免用户网络超时后重复创建同名文件。
如果一个批次是部分成功，则返回 created 和 rejected；绝不只显示“上传完成”掩盖失败。
媒体安全响应必须校验 MIME 与扩展名，处理 svg/html 等可能活动内容。
上传后返回 fileId、versionSeq=1、sha256、size、displayName、服务器完成时间。

### 7.2 编辑锁的服务端流程
```text
ACTIVE + no lock -> Acquire(user, base_seq) -> HELD(token, owner, expiry)
HELD + same user + valid token -> Renew -> HELD
HELD + other user -> 409 E_LOCKED(owner display name)
HELD + expired -> Acquire by new user（旧 token 作废）
HELD + normal Save succeeded -> new version committed -> release
HELD + Cancel -> release（验证 owner/token）
HELD + pending approval -> separate APPROVAL_HOLD（当前已签入版不变）
APPROVAL_HOLD -> approval approve/reject/conflict -> release hold / reconcile
```
Lock Acquire 必须在 PostgreSQL 事务内对文件加行锁（例如 SELECT FOR UPDATE），然后
检验文件仍 ACTIVE、modify 权限仍有效、是否存在 pending、版本号是否匹配。
生成不可猜测 lock token；Token 仅响应给持锁者，不显示在列表接口。
30 分钟超时以服务器时间为准，可合理续租；页面关闭无法可靠保证自动放锁，所以需 TTL。
只有持锁者/admin 的受控操作可释放；admin 强制解除要有审计并使旧 token 失效。
审批等待期间不能仅依赖 30 分钟编辑锁，因为审核可能持续数小时/数天；
必须使用单独的业务冻结状态，避免超时自动解除后可绕过审核。
同时打开两个浏览器标签时续租与释放必须防止旧标签误释放新锁。

### 7.3 保存与版本提交
客户端 Save 携带 `base_seq` 和锁 token；服务端再校验 modify/文件 ACTIVE/锁归属/expiry。
校验成功后才读取或接受文本内容；遇大 payload 的接收前可做初步配额检查。
无审批规则：检查 base_seq == current_seq → staging blob checksum → 事务内写 vN、
current_version_seq=N、file_text 索引与 audit → 成功后锁释放。
有审批规则：锁定当前版本，创建包含 base_seq 和 payload_blob 的 pending 审批单，
当前版本不动、查询/预览/下载继续返回旧签入内容；冻结待审修改能力。
重复 Save 同一 pending 返回 409 E_APPROVAL_PENDING，携已有审批号。
无锁直接调用 Save 返回 409，即使当前用户具有 modify 权限也不得绕过。
客户端收到网络错误后可以查询 idempotency_key 或最新版本，不能盲目重复签入。

### 7.4 审批过程
请求人提交 → 检查目录最近有效审批规则 → pending → 审批人或 admin 决定。
待审表只显示指定审批人有权处理的申请，普通人只看自己发起的单。
批准前用事务锁住 file + approval，确认 status=pending，base_seq 仍最新，
resource ACTIVE，申请内容完整、审批人有权；满足全部前提后写新版本并改 approved。
如审批期间出现外部版本变动，应进入 conflicted，不得覆盖别人提交的版本。
拒绝只改为 rejected、记录意见并解除 APPROVAL_HOLD，不产生新版本。
重复批准/拒绝不得改变第二次数据，返回受控冲突；并发两个审批人不能重复签入。
审批通知首期用页面待办和操作 toast；不要求邮件外部依赖。
审批规则被撤销、用户禁用或目录移动导致规则变化时，使用明确的失效/冲突策略。
管理员代审必须显示真实操作 actor，不能伪装成原指定审批人的动作。
测试须覆盖：两次点击批准、审批人被删除、文件被软删、权限撤销、blob 不存在、
旧版修改、锁超时、服务器重启、并发审批。

### 7.5 追加式回滚（DEC-13 / RESOLVED-03；第一期强制）
用户明确选择 Append-only rollback。原视频及 v2 的“回滚删除此后历史记录”仅作为历史行为证据，不是新版实现要求；严格禁止 DELETE seq>target 的回滚 SQL。

```text
v1(A) -> v2(B) -> v3(C)
选择“回滚到 v1”并成功提交：
v1(A) -> v2(B) -> v3(C) -> v4(action=rollback, bytes=A, targetSeq=1, fromSeq=3)
current_version_seq=4；v1、v2、v3、v4 均可查看，下一次签入必须产生 v5。
```

RB-01：回滚为追加一条新的不可变版本，所有原版本按原有 seq、时间、作者、checksum 保存，绝不隐藏或改写中间历史。
RB-02：新回滚版本的完整源字节、SHA-256、长度与选定历史版本一致；可安全复用不可变 blob，但必须产生新的 version id、seq 和审计。
RB-03：版本动作=rollback，记录 targetSeq、fromSeq、actorId、reason、requestId、时间；回滚到一个既有 rollback 版本也必须创建新的最新版本。
RB-04：仅 ACTIVE、同一文件、已正式签入的历史版本可作为目标；不得回滚到别的文件、待审草稿或已无权读取的秘密版本。
RB-05：回滚属于写操作，服务端必须同时校验 modify、有效本人编辑锁/令牌、expectedCurrentSeq、文件状态、当前审批冻结；admin 也不得豁免 CAS。
RB-06：当前文件是受审批目录时，回滚先创建含 target/from 的 pending 请求并冻结；旧 current 保持不变。只有审批人在重验基准版本/授权后批准，才正式追加 rollback 版本；拒绝不创建版本。
RB-07：pending 期间其他人的预览、下载、全文索引、CAD/DOCX 当前版本仍是旧 current；未审内容/派生不得泄露。
RB-08：同一 idempotencyKey 重试只返回相同结果/approvalId，不能因双击新建多个 seq；并发回滚与保存、审批通过只能有一个满足 current CAS 的事务胜出。
RB-09：事务内保持版本、current 指针、审计、索引更新/异步任务、衍生文件版本引用一致。失败不改变 current，不报告成功。
RB-10：rollback 对历史模型源文件/历史 DOCX、已有派生物、缩略图及源 blob 均无删除副作用；新当前版本引用与目标 checksum 一致，可复用对应派生但必须绑定新 seq。
RB-11：软删/TRASHED/PURGED、权限变化、基准版本过期、锁超时、已有 pending 均阻断普通回滚。
RB-12：业务版本回滚与数据库/磁盘灾难恢复是不同机制，必须分别留日志和权限。
RB-13：目录移动、软删后恢复、再次回滚都不重置或复用 seq；seq 永远单调递增。
RB-14：版本历史提供目标和当前版本比较摘要，回滚需要二次确认，UI 文案必须说明“目标内容会被复制为新版本，全部历史继续保留”。

#### 7.5.1 API 和错误约定
POST /api/files/:id/rollback 接收 `{targetSeq,expectedCurrentSeq,lockToken,reason,idempotencyKey}`。只传旧 `{seq}` 不能绕过 CAS、锁和审批。
非审批目录实际事务提交成功返回 200：`{versionSeq,rollbackTargetSeq,rollbackFromSeq,sha256,auditId}`。
审批目录返回 202：`{status:"pending",approvalId,expectedCurrentSeq}`，不会提前更改 current。
版本/锁冲突、审批 pending、无权、目标不存在、资源已删除分别返回受控 409/403/404 和稳定 error.code；不得把失败显示为成功。

### 7.6 删除、回收站与恢复状态机
```text
ACTIVE --softDelete--> TRASHED (trash entry + original location)
TRASHED --restore--> ACTIVE (same logical id, same versions)
TRASHED --purge--> PURGED (irreversible at product level, backup may recover)
TRASHED --move/rename/save--> reject
PURGED --restore--> reject
```
软删除文件不物理删 blob、版本、审计、共享和关注记录，而是屏蔽其生效读取路径。
删除文件夹需把整个子树视为 TRASHED；应只产生一个顶层 trash entry，
避免子目录恢复后被根目录第二次恢复。
共享在 TRASHED 时不可访问，不需要把 share 永久撤回；恢复后是否重新启用原分享，
本草案建议“恢复后分享维持撤销/失效状态，需显式重新授权”，安全优先。
关注维持个人元数据但显示“已删除”，不具备恢复权限者不能看到详细秘密路径。
恢复父目录不存在时允许选择一个有权的目标目录，否则返回 E_PARENT_MISSING。
恢复同名冲突时返回 E_NAME_CONFLICT，允许用户显式选择新名称，不自动覆盖在用文件。
恢复后 fileId 和版本历史保持不变；重建搜索索引与 folder tree 的授权可见性。
purge 必须有严格管理权限和二次确认；标记 GC 待删除以避免审计断链，
清理状态由后台作业或下次启动恢复；不能先删 blob 后因 DB 错误漏删引用。
本期可不提供自动 30 天清空，但要预留 purge_after 策略字段，不能暗中自动销毁数据。

### 7.7 共享与关注的状态流
ShareCreated -> Active -> Expired / Revoked；资源删除时 ResourceUnavailable，
不删除分享审计。撤回后接收方旧标签再读取立即 403/404。
用户被禁用则分享不应再生效，工作组成员移除后按下一请求动态变化。
收藏 FavoriteAdded -> FavoriteRemoved；资源失权时列表不泄露秘密详情，
但用户可以管理自己那条失效关注元数据。
重复关注为幂等 200，重复取消也幂等；同一 resource 不出现两行。
分享一个文件夹时子目录授权继承策略独立于原 folder ACL，深层目标仍须逐请求检查。
所有状态转换记录审计 actor、时间及前后状态，不允许单靠前端状态机提供安全保障。

---

## 8. Plain Text-B：文件内容保真与安全渲染

### 8.1 内容与语义分离
“Plain Text”是文件字节解码、显示和保存语义，不是要求全部页面都使用无样式文本。
界面可以使用 SVG、CSS、表格和响应布局；文件内容本身必须在 Plain Text 模式按原文呈现。
`.md` 的 `# Title`、`**bold**` 和 `<script>` 应显示为字面内容。
不要用 `dangerouslySetInnerHTML` 去渲染用户提供的纯文本。
检索高亮将正文分段为纯文本节点和受控 `<mark>` 节点，不能把预期片段拼进任意 HTML。
DOCX HTML 和 SVG 文件另采用严格清洗、CSP/iframe sandbox 或安全附件策略。

### 8.2 字节准确性
下载接口是源字节的权威出口。预览/文本编辑器解码前计算 SHA-256，
并记录 charset、BOM、行尾风格及末尾换行是否存在。
UTF-8 无 BOM 默认支持，UTF-8 BOM 需要保留；CRLF 与 LF 不得在编辑时无意转换。
混合 CRLF/LF、非法 UTF-8、未知编码、NUL 含量异常，若无完整无损方案则只读。
Tab、连续空格、尾随空格、空行、emoji、中文、各种引号与尖括号都必须保留。
可用 monospace + pre-wrap/white-space:pre 提升可视化，但 soft-wrap 只影响排版，不改变字节。
前端内部 textarea 的行尾标准化必须由显式序列化器恢复；不能把 DOM `innerText` 当下载字节。
纯文本 Save 只能生成 byte-accurate 的 blob，禁止无提示修剪、补末尾换行或统一编码。
“用户没有点保存”保证文件 checksum 和版本都不变；
“点击保存但内容没有变”按现行 v2 每次签入新增版本的意向执行（OPEN-06 可改）。

### 8.3 大文件和错误处理
文本预览达到服务端限制必须明确标注 `truncated: true`、原字节大小、返回量与下载操作。
被截断的预览不允许直接进入“保存全文件”动作，否则会把未加载部分丢掉。
展示行号可以是只读辅助手段，不能作为文件内容写入。
无效编码显示解释和下载入口，不得用 Unicode replacement char 覆盖源文件。
二进制文件即使带 .txt 扩展名也应按安全策略拒绝纯文本编辑。
字符数不等于 UTF-8 字节数，限制同时声明字符和字节行为。

### 8.4 12 个字节样本
PT01 UTF-8+LF：首尾空白、Tab、末尾 LF，预览和下载 SHA 一致。
PT02 UTF-8+CRLF：逐行检查 `0d0a`，编辑后行尾不丢失。
PT03 UTF-8 BOM：`efbbbf` 保留，显示不额外多出可见乱码。
PT04 混合行尾：未获支持时只读告警，不执行有损保存。
PT05 非法 UTF-8/NUL：只读且告警，不转为替换字符。
PT06 `<script>alert(1)</script>`：按字面显示，浏览器不执行。
PT07 Markdown 原文：文本预览不转化标题/链接 HTML。
PT08 长单行：可滚动、不无声截断，保存 checksum 一致。
PT09 超大文本：截断提示、正确大小和完整下载入口。
PT10 A/B 修改竞争：后发旧版本写入 409，不覆盖新版本。
PT11 预览不保存：文件、版本、索引、blob 均零变动。
PT12 版本保存/审批/回滚：下载 SHA、索引、预览、历史记录一致。
每个样本必须具备可复制输入文件、expected SHA-256、完整 API 请求、
服务器 checksum 和浏览器行为证据；不能只输出 PASS 字样。

### 8.5 DOCX 在线富文本编辑（用户已确认首期必做）
视频约 03:00–03:15 有 Ribbon 与纸张编辑界面。旧 Node 的 contenteditable + innerText 无法持久化复杂格式，属于必须纠正的迁移缺陷。
第一期必须真实打开 DOCX、修改正文和基础格式、保存有效 DOCX 二进制新版本，并纳入编辑锁、审批、版本、审计及搜索索引。
技术基线是集成自托管 ONLYOFFICE Docs 或经同等验收的文档编辑服务；**不能以 Plain Text 转写、前端 contenteditable 或修改扩展名代替 DOCX 写回**。
默认采用“文件级单写者业务锁 + 编辑器会话”，而非无约束多人同时协同写一个签入版本；编辑引擎的内部保存和系统签入是两个不同动作。
字段、回调、JWT、保存时机、临时文件、冲突和格式回归验收详见 §19。无编辑引擎的环境只能明确提示服务不可用，不能声称 DOCX 编辑完成。

---

## 9. API 契约（原接口保留 + 第一阶段扩展）

### 9.1 基础和旧 API
保留：POST /api/login、POST /api/logout、GET /api/me；
GET /api/departments、POST /api/departments、GET /api/groups、
POST /api/groups、POST /api/groups/:id/members、DELETE /api/groups/:id/members/:uid；
GET/POST /api/users；
GET /api/folders/tree、POST /api/folders、GET/POST /api/folders/:id/acl、
GET /api/folders/:id/perm、DELETE /api/acls/:id；
GET/POST /api/folders/:id/files；
POST /api/files/:id/rename、POST /api/files/:id/move、DELETE /api/files/:id；
GET /api/files/:id/download、GET /api/files/:id/raw、GET /api/files/:id/preview；
POST/GET/DELETE /api/files/:id/lock；
GET /api/files/:id/versions、POST /api/files/:id/rollback、POST /api/files/:id/save；
GET /api/approvals、POST /api/approvals/:id/decide、GET /api/search。
旧 API 的字段兼容与新增 lock token/baseSeq 之间须定义兼容窗口；
高危旧无锁 save 不能继续无校验运行，应返回显式升级错误。

### 9.2 新增接口路由矩阵
| 方法 | 路径 | 必要条件 | 行为 |
|---|---|---|---|
| GET | /api/trash | 已登录；返回有权条目 | 列表筛选/分页 |
| POST | /api/trash/:id/restore | restore 权限/目标合法 | 恢复原位或指定位置 |
| DELETE | /api/trash/:id | purge_trash | 永久删除并记录 GC |
| POST | /api/trash/bulk-restore | 按项判定 | 批量恢复，逐项结果 |
| GET | /api/shares/received | 已登录 | 我收到的共享 |
| GET | /api/shares/sent | 已登录 | 我发出的共享 |
| POST | /api/shares | manage_share | 创建内部分享 |
| PATCH | /api/shares/:id | 分享创建者/管理权限 | 修改有效权限或截止时间 |
| DELETE | /api/shares/:id | 分享管理权限 | 撤销分享 |
| GET | /api/shares/:id | 对该分享有权 | 分享详情 |
| GET | /api/favorites | 已登录 | 个人关注列表 |
| PUT | /api/favorites/:kind/:id | 有权可见 | 幂等添加关注 |
| DELETE | /api/favorites/:kind/:id | 本人 | 幂等取消关注 |
| GET | /api/stats | 有权统计范围 | 按筛选聚合 |
| GET | /api/exports/files.csv | 有列表导出权限 | CSV 下载 |
| POST | /api/files/:id/lock/renew | 持有效 token | 续租 |
| GET | /api/files/:id/metadata | 有效 preview/list | 可见文件元数据 |
| GET | /api/files/:id/bytes-meta | 有效 preview | 编码/行尾/checksum 元数据 |
| POST | /api/files/:id/move | 来源 move + 目标 upload | 单文件移动（CAS + 幂等 + 审计） |
| POST | /api/files/move-batch | 来源 move + 目标 upload | 批量移动，all-or-nothing（上限 100 文件，幂等 + 审计） |
| POST | /api/moves/preflight | 已登录 | 移动前只读预检（UX 提示，非授权证明） |
| GET | /api/folders/children | 已登录；parentId 需 list | FolderPicker 子目录分页（可见根/孤立根；不可见父目录 404） |
| GET | /api/folders/search | 已登录；q 非空 | 可见目录名检索分页，path 在不可见祖先处截断 |

### 9.3 新增 API 请求响应示例
```json
POST /api/shares
{
  "resourceKind": "folder",
  "resourceId": "fd_abc",
  "recipientKind": "group",
  "recipientId": "g_market_ws",
  "actions": ["list", "preview", "download"],
  "includeDescendants": true,
  "expiresAt": null
}
```
成功 201: `{"ok":true,"data":{"id":"sh_xxx","status":"active","actions":["list","preview","download"]}}`。
失败 403：不能分享无权限动作；失败 404：资源不存在或不可见。
```json
POST /api/trash/tr_xxx/restore
{ "destinationFolderId": "fd_target", "onNameConflict": "fail" }
```
成功 200 返回原 resourceId、原 versionSeq、restoredAt；失败 409 提供冲突名称和可选目标说明。
```json
GET /api/stats?scope=currentFolder&folder=fd_abc&includeDescendants=true
```
返回 `{"ok":true,"data":{"totalFiles":0,"totalFolders":0,"totalBytes":0,"byType":[],"byMonth":[],"scope":"currentFolder"}}`。
```json
GET /api/exports/files.csv?folder=fd_abc&scope=descendants&sort=updated_desc
```
响应 UTF-8 BOM `text/csv; charset=utf-8`，`Content-Disposition: attachment`；
必须过滤越权对象，中和 Excel 公式字段，记录 export audit。
```json
POST /api/files/f_xxx/save
{ "data": "data:text/plain;base64,...", "baseSeq": 2, "lockToken": "opaque-random", "idempotencyKey": "opaque-client-key" }
```
成功返回 versionSeq、新 SHA-256、大小、lockReleased；需审批返回 pending,approvalId；
409 返回机器可判断的 E_LOCKED/E_VERSION_CONFLICT/E_APPROVAL_PENDING。
```json
POST /api/files/f_xxx/move
{ "targetFolderId": "fd_target", "expectedFolderId": "fd_source", "idempotencyKey": "opaque-client-key" }
```
成功 200：`{"ok":true,"data":{"fileId":"f_xxx","fromFolderId":"fd_source","toFolderId":"fd_target","status":"committed"}}`；
稳定 file id、版本历史与内容哈希不变，新增 file.move 审计事件，权限 epoch 缓存失效。
`expectedFolderId` 是 CAS 守卫，与当前所在目录不一致返回 409 E_VERSION_CONFLICT（不静默移动）；
目标为自身所在目录返回 409 E_MOVE_CONFLICT；目标不存在/已删除/不可见返回 404 E_NOT_FOUND；
目标已有同名文件返回 409 E_NAME_CONFLICT；来源无 move 或目标无 upload 返回 403 E_FORBIDDEN。
相同 idempotencyKey 重放返回同一 `{fileId,fromFolderId,toFolderId}`，不重复移动、不重复审计。
```json
POST /api/moves/preflight
{ "resources": [{"kind":"file","id":"f_1"}], "targetFolderId": "fd_target", "mode": "all_or_nothing" }
```
成功 200：`{"ok":true,"data":{"status":"ready","candidateRevision":"opaque-revision","allowedCount":1,"conflicts":[],"warnings":["目标目录继承权限将重新评估"],"sourceSummary":"研发部 / 项目A","targetSummary":"研发部 / 项目B"}}`；
冲突时 status 为 conflict/forbidden，conflicts 逐项 `{id,code,message?}`，code 与提交路径一致。
预检为只读 UX 检查：不写任何数据、不加锁，`candidateRevision` 不是授权令牌，提交仍在事务内重验全部条件。

### 9.4 查询、安全与异常响应规则
所有 query `folder,resourceId,user,dept` 必须在服务端验证是否存在和调用者可见；
不能把前端下拉框值作为授权证据。
不能根据“搜索结果已经是可见的”就允许 GET /api/files/:id/raw 跳过权限检查。
共享和关注列表里的失效资源不显示未授权祖先完整路径，必要时返回脱敏的 unavailable item。
列表分页有稳定排序键，避免同时间戳重复或漏页；导出范围与表格查询使用同一过滤器。
跨目录复制、下载 ZIP、远程分享匿名访问不在现有接口范围内，不得临时扩张成默认交付。
每个新接口在实现前需要 OpenAPI/schema 类型、至少一个正向、一个负向和一个数据一致性测试。

### 9.5 回滚 API（DEC-13：追加式）
请求：POST /api/files/:id/rollback
```json
{
  "targetSeq": 1,
  "expectedCurrentSeq": 3,
  "lockToken": "opaque-token",
  "reason": "恢复误修改前的内容",
  "idempotencyKey": "uuid-or-equivalent"
}
```
普通目录成功 200：
```json
{"ok":true,"data":{"versionSeq":4,"action":"rollback","rollbackTargetSeq":1,"rollbackFromSeq":3,"sha256":"64-char-hex","status":"committed"}}
```
审批目录提交后 202：
```json
{"ok":true,"data":{"status":"pending","approvalId":"app_xxx","expectedCurrentSeq":3,"rollbackTargetSeq":1}}
```
含义：202 只表示回滚申请已提交，普通用户仍下载和预览 v3；只有审批成功后才创建新的 v4。
版本列表 GET /api/files/:id/versions 必须按 seq 返回全部已签入历史，并包含 action、
rollbackTargetSeq、rollbackFromSeq、sha256、versionSeq、createdAt、createdBy；不隐藏 v2/v3。
旧版仅传 seq 的请求不能绕过锁、CAS、审批；可返回明确的 400 E_BAD/409 E_VERSION_CONFLICT 并提示升级。
幂等请求用唯一 (user_id,file_id,idempotencyKey) 追踪结果；重试返回相同 versionSeq/approvalId，
不能用“同一个目标版本”代替幂等键（用户以后可能合法再次回滚到 v1）。
所有错误使用已有标准 JSON error 和 requestId；禁止返回 200 但业务失败的混合语义。

### 9.6 文件移动与预检（COMPLEX-WORKFLOWS §3，G3 后端）
提交：POST /api/files/:id/move，请求 `{targetFolderId,expectedFolderId,idempotencyKey}`。
- 单事务内重验来源目录 `move`、目标目录 `upload`、目标存在且未删除、目标内名称唯一与文件活跃状态；
  `expectedFolderId` 与当前目录不一致返回 409 E_VERSION_CONFLICT；目标为自身所在目录返回 409 E_MOVE_CONFLICT。
- 成功保持稳定 file id、版本历史与内容哈希；写入 `file.move` 审计事件；提交后按现有权限 epoch 失效缓存，
  搜索/关注/共享范围在下一个请求重算。
- 幂等：以 (user_id,file_id,idempotencyKey) 记录 `{fileId,fromFolderId,toFolderId}`，与 save/rollback 同一机制；
  重放返回相同结果，不产生第二次移动或审计行。批量移动见 §9.7（上限 100 个文件）；
  目录移动（POST /api/folders/:id/move）复用同一机制。

预检：POST /api/moves/preflight，请求 `{resources:[{kind,id}],targetFolderId,mode}`，只读，不写任何数据、不加锁。
- status：`ready`（全部可移动）/`conflict`（重名、不存在、已在目标等）/`forbidden`（权限不足）；
  conflicts 逐项 `{id,code,message?}`，code 使用与提交一致的标准错误码（E_FORBIDDEN/E_NAME_CONFLICT/
  E_NOT_FOUND/E_MOVE_CONFLICT/E_BAD）。
- `candidateRevision` 为不透明串，不是授权令牌；提交路径在事务内重验全部条件，预检结果只作 UX 提示。
- `sourceSummary`/`targetSummary` 仅包含调用方可见的目录名，不可见祖先处截断，不泄露隐藏路径或名称；
  目标对调用方不可见时返回 404 E_NOT_FOUND，与“不存在”不可区分（SAFE-04）。
- mode 仅支持 `all_or_nothing`；任一资源冲突时提交不得产生部分写入。

### 9.7 批量文件移动（COMPLEX-WORKFLOWS §3.2 草案 C，ADR-UX-02 / WF-07 / WF-08）
请求：POST /api/files/move-batch
```json
{
  "fileIds": ["f_1", "f_2"],
  "targetFolderId": "fd_target",
  "mode": "all_or_nothing",
  "idempotencyKey": "opaque-client-key"
}
```
- 上限：单次最多 100 个文件（服务端常量 MaxMoveBatchFiles）；超出返回 400 E_BAD，error.message 说明上限
  （`fileIds exceeds the batch limit of 100`）。fileIds 为空、targetFolderId 为空、fileId 重复或 mode 为
  `all_or_nothing` 之外的其它取值同样返回 400 E_BAD（mode 缺省视为 `all_or_nothing`），且在任何数据库写入前拒绝。
- 全部成功/全部失败（ADR-UX-02）：服务端在同一事务内先逐项重验来源目录 `move`、文件活跃状态、目标目录存在且
  未删除、目标目录 `upload`、文件是否已在目标目录、目标内名称唯一（含批次内两个文件同名），全部通过后才执行移动；
  任一失败则整批不写入——没有部分移动、没有审计行，事务回滚。
- 成功 200：
  `{"ok":true,"data":{"status":"committed","moved":[{"fileId":"f_1","fromFolderId":"fd_source","toFolderId":"fd_target"}],"conflicts":[],"count":2}}`；
  moved 按请求顺序逐项给出 from/to，count 为已移动文件数；保持稳定 file id、版本历史与内容哈希不变；
  每个文件写一条 `file.move` 审计事件；提交后按现有权限 epoch 失效缓存，搜索/关注/共享范围在下一个请求重算。
- 冲突 200：status 为 `conflict`，moved 为空，conflicts 逐项 `{id,code,message?}`，code 使用与单文件提交一致的
  稳定错误码（E_FORBIDDEN/E_NOT_FOUND/E_NAME_CONFLICT/E_MOVE_CONFLICT），count 为冲突项数；
  用户可排除问题项后重新预检/重试。
- 幂等：以 (user_id, `file.move-batch:`+排序后的 fileIds, idempotencyKey) 记录整个提交结果
  `{status,moved,conflicts,count}`，与 save/rollback 同一机制；重放返回相同结果，不产生第二次移动或审计行。
  冲突结果不写入任何记录（事务已回滚），相同请求重放会重新校验并返回相同的冲突列表。
- 批量请求不含 CAS 字段：`expectedFolderId` 是单文件守卫，批量无语义；并发改名/移动由事务内名称唯一与数据库
  唯一索引最终拒绝（E_NAME_CONFLICT，整批不写入），不静默覆盖。

### 9.8 目录分页读取（FolderPicker children/search，COMPLEX-WORKFLOWS §2.3 / ADR-UX-07 / WF-10）
`GET /api/folders/tree` 保持不变，继续返回整棵可见树（小树字段与行为字节兼容）；大数据集（万级目录）改用下面
两个只读分页端点按需加载，二者都不写库、不加锁、不产生审计或幂等记录。

**GET /api/folders/children?parentId=&cursor=&limit=**
- `parentId` 省略或为空表示调用方**可见根**：没有父目录的目录，以及父目录不在调用方可见集合内的目录；权限裁剪后的
  孤立子树显示为可访问根，不泄露隐藏祖先（DI-07/DI-14）。
- 其余情况下 `parentId` 必须存在且调用方在该目录持有 `list`；否则返回 404 `E_NOT_FOUND`，与“目录不存在”完全
  不可区分——探测无法判断隐藏与不存在（SAFE-04）。已删除（回收站中）的目录同样回答 404。
- `limit` 缺省 50，服务端上限 200（`ports.MaxFolderPage`，与文件列表同约定）；非正整数返回 400 `E_BAD`，
  超过上限按上限截断而不是报错。服务端按 `limit+1` 预读一行判断是否还有下一页。
- 排序为 `name` 升序、同名时 `id` 升序（与树列表同一键）；游标是上一页最后一行的 `(name,id)` 键，base64url
  无填充、不透明，客户端原样回传即可续页。无法解析的游标按空游标处理（等同于第一页），不返回错误。
- 响应：
  `{"ok":true,"data":{"items":[{"id":"fd_a","name":"市场部","parentId":"fd_root","hasChildren":true,"canSelect":false,"disabledReason":"没有上传权限"}],"nextCursor":""}}`
  `nextCursor` 为空表示已是最后一页。
- item 字段：
  - `parentId` 为 null 表示可见根；孤立根仍带真实 `parentId`，客户端据此识别父目录不可见。
  - `hasChildren` 表示存在调用方**可见（可 list）**的子目录；服务端用 EXISTS 探测，不加载整棵子树。
  - `canSelect` 仅是 UI 提示：调用方在该目录持有 `upload`（直接授予、继承与分享的并集）时可作为移动/上传目标；
    提交事务会重新校验权限，客户端不得把它当作授权凭证。
  - `disabledReason` 只在 `canSelect=false` 时出现，是简短公开理由（当前固定为“没有上传权限”），永不解释不可见原因。

**GET /api/folders/search?q=&limit=&cursor=**
- `q` 必填；空或只含空白字符返回 400 `E_BAD`（不把空查询当作“全部目录”）。
- 只匹配调用方可 `list` 的目录名：大小写不敏感的包含匹配，与文件搜索一致的 ILIKE 语义（`%` 与 `_` 仍按通配符处理）。
- 排序、游标、`limit` 缺省与上限、错误码规则与 children 相同。
- item 形状与 children 相同，另加 `path`：可 `list` 的祖先名用 `" / "` 连接，到第一个不可 `list` 的祖先处截断，
  不臆造、不泄露隐藏祖先名；孤立子树的 path 只含自身名称。
- 隐藏目录既不能按名称命中，也不能从条数、错误码或耗时上被推断出存在（SAFE-04）；跨目录搜索的可见路径使用同一
  可见性判定，不出现“目录页看不到、搜索页看得到”的分叉。

两个端点都要求已登录；`mustChangePassword` 会话与其它业务路由一致返回 403 `E_PASSWORD_CHANGE_REQUIRED`。
读取不缓存分页结果，`list`/`upload` 判定在请求内实时解析，因此撤权后的下一个请求立即看不到该目录。

---

## 10. 全文检索与元数据查询

### 10.1 索引源与提取策略
上传/保存/审批生效/回滚后更新当前版本索引，删除和恢复更改文件可见性但不得恢复未经审核的草稿。
纯文本使用经过判定的 UTF-8 解码，保留正文供摘要；DOCX 用可控 ZIP/XML 提取正文，失败时以文件名降级并标记 index_warning。
图片、视频、PDF 若未实现文本抽取，至少索引文件名和明确可提取元数据；不得谎称所有 PDF 都已全文 OCR。
原始文件正文不得放入前端 Zustand 全局持久缓存或浏览器本地可长期恢复存储。
当前索引对应 current_version_seq；版本回滚完成前不能返回新旧混杂的索引。
非法输入、过度重复字符、巨型无空格 CJK 文本不得导致 SQL 错误或无上限 CPU/内存占用。

### 10.2 中文与短语语义
PostgreSQL simple 配置不执行传统中文分词；对 CJK 字符两侧插空格建立 spaced 列和 tsvector。
查询前做相同的 spaced 处理，再用 phraseto_tsquery 保留相邻字符次序；以真实语料评估误报漏报。
关键样本：预算、年度预算、2026年度预算、项目-预算、A/B测试、JSON、DFS、英文大小写、包含引号和特殊符号。
fts 查询错误时可降级参数化 LIKE，必须对 %、_、反斜线和转义写明语义；不把用户输入直接拼 SQL。
引擎状态 engine=tsvector 或 like，ms 是后端实测用时而非视频中的固定 0.0076 秒。
优先在 SQL 候选筛选前就注入权限约束，或确保授权过滤在返回 total/snippet 前完成。
分页、排序、部门和上传人过滤不可在限制 200 个候选后才引发错误的“总数/结果”语义；
必须明确 total 为授权+全部筛选完成后的真实总数或被硬性 cap 的受限总数。

### 10.3 结果卡与无权过滤
结果展示文件名、可见路径、类型图标、上传人、更新时间、正文摘要、命中高亮。
摘要裁剪以 Unicode 字符/字素簇或安全 rune 为边界，不切坏 UTF-8；
在 JSX 中只将被命中的字符串放入 mark 元素，其他都是 text node。
若用户缺 preview 但有 list，可展示文件名不展示正文摘要，避免内容侧漏；
如果当前产品定义仅同时满足 preview 才进入检索正文，应在权限矩阵和 API 中写死。
无权用户即便查询唯一关键词也不能凭 total、时间或错误差异推断秘密文件存在。
当用户通过共享获得一份文件的 preview 时，搜索可依据分享范围显示该文件，
但不得因此索引/公开未共享的同级文件。

---

## 11. React 前端工程、交互状态与无障碍

### 11.1 数据访问规范
core/api.ts 负责 credentials:same-origin、统一请求错误、requestId、401 跳转、
409 冲突提示和请求取消，禁止在每个页面复制 try/catch 逻辑。
Zustand 保存会话摘要、当前目录、树展开、选择集、缓存的权限和待审计数；
文件正文和含高敏信息的审批 payload 不应长期放入全局状态。
所有页面加载显示 skeleton 或清楚的“加载中”；请求失败保留重试操作；
路由离开时 AbortController 取消过期请求，避免跨目录竞态。
页面上禁用按钮的理由来自权限计算和资源状态，不让用户猜测“为什么不能点击”。
敏感 API 响应不得交由浏览器 Service Worker 离线缓存，首期不引入离线功能。
日期输入按用户本地时区展示、UTC 保存；截止时间过期由服务器判定。

### 11.2 组件契约
Shell：品牌、导航、用户信息、面包屑、全局搜索、响应式折叠。
FolderTree：展开、折叠、键盘导航、选中高亮、不可见祖先占位。
FileTable：排序、多选、空态、锁/审批状态、操作栏、行内预览。
ToolBar：单项/多项可执行动作计算、按钮图标、确认与失败状态。
OrgTree/MemberCards：部门/组选择、成员多选、增删与详情。
PermDialog：主体类型/动作九宫格/到期/仅本目录/已生效权限来源/撤销授权。
MoveDialog：目标目录树、无权禁选、防自环、二次确认。
PreviewViewer：kind 分发、文本安全、媒体响应、DOCX 降级提示。
TextEditor：编码/EOL 判定、脏状态、保存锁 token、基准版本与冲突。
RichEditor：DOCX 编辑已确认必须实现，使用可真实写回 DOCX 的自托管编辑服务；不能使用“假持久化” Ribbon。
VersionHistory：历史表、回滚确认、版本链信息。
ApprovalCenter：todo/mine、决定意见、状态颜色、审批 hold 显示。
TrashTable：已删根项、恢复和 purge、父目录冲突反馈。
ShareDialog/SharedList：内部对象选择、有效期、权限限制、撤销。
FavoritesList：关注状态同步、失权/已删提示。
StatsDashboard：授权范围、指标、空态、加载误差、导出跳转。
ExportDialog：范围/筛选预览、CSV 导出、部分失败/权限变化提示。
Toast/Modal：可读错误和成功消息、Esc 退出、危险动作确认。

### 11.3 设计 token 与视频结构契约
视觉基准以官方 Logo 的亮蓝与深蓝为源，白/浅蓝白为主体、深蓝保证交互文字对比、文件夹 SVG 黄色有限保留；统一 token 规范、排版和组件验收详见 §11.5。
组织页/文档页必须保留视频的双栏信息架构，但不等于复刻浏览器外壳。
固定桌面基准视口 1440×900，另测 1366×768、1920×1080；
当前没有授权把截图压缩尺寸推导成具体像素 CSS。
列表密度至少提供清晰字段和可点击热区，不能用过宽卡片导致文件表的四列缺失。
权限弹窗必须足以完整显示九动作、用户/组选择、有效期和作用域；
窄视口允许局部滚动，但提交按钮不能被内容遮住。
UI 图标仅内联 SVG；视频/图片文件本身可以是位图，正文可以包含 emoji；
不要把这项 UI 规则误判为禁止上传包含 emoji 字符的文件。
品牌替换不影响交互结构：企业和岗位名称统一使用 seed 的中晟生物科技数据。

### 11.4 表格、对话框和键盘验收
所有危险操作（删除、永久删除、回滚、撤销共享）先预览影响范围，再确认；
确认按钮不得因为点击两次造成重复提交，pending 时禁用并使用 idempotencyKey。
选择多文件批量操作需显示已选数量，分页/切目录后选择状态采用明确清空策略。
操作成功后如果列表刷新失败，不能显示“所有任务已完成”而隐瞒读取失败。
焦点管理：弹窗打开移入焦点，关闭恢复触发按钮；Tab 循环在模态内；
Escape 可取消非关键表单，永久删除等危险提交过程中 Escape 不应造成误提交。
所有输入有 label，文件行关键操作有 aria-label，警告颜色有文字标签；
不靠唯一颜色表达审批状态、过期或锁拥有者。
视觉截图比对必须固定测试数据，隐藏浏览器扩展/录屏字幕，不把相似度分数当唯一验收。

### 11.5 Logo 驱动的视觉设计系统（DEC-14 / RESOLVED-01）

#### 11.5.1 视觉定位与证据
VIS-BRAND-01 [USER] 用户明确决定：“按照 Logo 的风格来”。本决策覆盖先前 OPEN-01 的灰白复刻与浅蓝白择一问题：**以正式 Logo 的亮蓝/深蓝与白色留白为品牌设计源；保留视频信息架构、操作流程、密度和功能，不复刻旧演示的灰白皮肤**。
VIS-BRAND-02 官方 Logo 图形具有明亮蓝色主体、深蓝渐变片段、白底与简洁抽象几何形态；UI 应呈现可靠、清爽、有精密机械工程秩序感的企业应用，而非活泼社交产品、游戏界面或消费级大渐变仪表盘。
VIS-BRAND-03 原图 JPG 内代表性取样颜色包括亮蓝约 #02A0EA、深蓝约 #174098。图像包含 JPEG 压缩与渐变，样本点不构成正式品牌色彩管理文件。可衍生更深的交互色及更浅的背景色，但 Logo 本体必须使用原始资产，不重绘成固定纯色。
VIS-BRAND-04 网站以白底为主，蓝色用于导航选择、主按钮、焦点、链接与有限品牌装饰；不允许整页大面积蓝色渐变、霓虹发光、玻璃拟态或深色游戏 HUD。CAD 查看器内部可用中性深色画布，主系统仍是明亮主题。
VIS-BRAND-05 保留既定黄色文件夹 SVG 标识作为文件管理习惯性语义色，但它不是第二个品牌主色；黄只用于文件夹、明确警告，不用来涂满导航/背景。
VIS-BRAND-06 此为统一主题，文件管理、组织/组管理、回收站、共享、关注、审批、统计、DOCX 外框和机械模型查看页采用一致 token 与控件风格，不得逐页换一套主题。
VIS-BRAND-07 正文文件中的彩色图片、视频帧、CAD 部件材质不受品牌蓝限制；不得用 CSS 强制覆盖模型原有材质颜色或 DOCX 内文原有颜色。
VIS-BRAND-08 无法从原录屏推导出规范 CSS px；所以几何布局优先视频结构，颜色、形状与组件按本品牌设计合同。不能报告“与视频逐像素一致”，应报告“视频结构与行为一致 + 新品牌视觉一致”。

#### 11.5.2 Design Tokens v1（CSS 自定义属性）
下列值是**根据 Logo 代表性蓝色构建的第一期 UI token 规范**，品牌图片并非 CSS 画出的替代图形。组件不得私自另写大量随机蓝色/灰色 hex，交互态优先 token 化。
```css
:root {
  --brand-cyan: #02A0EA;          /* Logo 亮蓝：图形/品牌强调，避免直接作为小字颜色 */
  --brand-navy: #174098;          /* Logo 深蓝：导航/按钮/标题 */
  --brand-mid: #275FAA;           /* 过渡蓝：小面积线条、控件边界 */

  --color-app-bg: #F4F9FE;        /* 页面大面积浅蓝白 */
  --color-panel: #FFFFFF;         /* 面板、表格、弹窗 */
  --color-panel-soft: #F7FBFF;    /* 左侧栏/列表区 */
  --color-soft-blue: #E8F5FD;     /* hover 软蓝 */
  --color-selected: #DFEFFB;      /* selected 底色 */
  --color-selected-stroke: #2386C9;

  --color-text: #20344E;          /* 正文高对比深蓝灰 */
  --color-text-secondary: #53677D;
  --color-link: #174098;          /* 不用亮青作为小字体链接 */
  --color-line: #D1E1EC;
  --color-line-strong: #B4CADB;

  --color-action: #174098;        /* 主按钮配白字 */
  --color-action-hover: #103679;
  --color-focus: #1473B8;
  --color-success: #17765D;
  --color-warning: #995E05;
  --color-danger: #AA3145;
  --color-folder: #E3AD3D;        /* 文件夹 SVG 的有限语义黄 */

  --radius-xs: 4px;
  --radius-control: 8px;
  --radius-card: 12px;
  --radius-dialog: 14px;
  --shadow-float: 0 8px 24px rgba(20, 55, 102, .10);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  --font-ui: "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  --font-mono: ui-monospace,"SFMono-Regular",Consolas,monospace;
  --font-size-sm: 12px;
  --font-size-base: 14px;
  --font-size-title: 18px;
  --font-size-page: 22px;
}
```
BRAND-TOKEN-01：所有文案保持 WCAG 2.2 AA 风格的常规对比度门槛：正文 ≥4.5:1，大文本 ≥3:1；操作状态和可识别图标的必要边界 ≥3:1。仅装饰性蓝色无须满足文字对比，但不得承担唯一状态语义。
BRAND-TOKEN-02：白字主按钮使用深蓝 --color-action，Logo 亮蓝仅作装饰/强调；“白字+亮蓝”若对比不足必须换深蓝，不因追求品牌一致性牺牲可读性。
BRAND-TOKEN-03：禁用态除了灰度还应取消可点击指针或标注不可用原因；成功/危险/警告不只靠绿/红/黄表达，必须配图标与文字。
BRAND-TOKEN-04：CSS 值在验收样本中接受微调，但 token 变更必须同步全部页面视觉回归；禁止通过局部页面的 hardcoded 色值绕过设计系统。
BRAND-TOKEN-05：阴影只在浮层、菜单、弹窗和极少数摘要卡使用；普通文件表以 1px 边框/淡色行 hover/分割线表达层级。
BRAND-TOKEN-06：只支持本期明亮主题，不为“可能将来有暗黑模式”在第一期加入一套未测样式；CAD 深色画布是内容查看环境，不等于全站暗黑主题。

#### 11.5.3 网格、信息密度与排版
LAYOUT-01：桌面主要面向 1366、1440 与 1920px 宽视口。顶部全局条建议高度 60–68px；Logo 保持 1:1 等比，图形主要可见边长约 34–42px，并与系统名称组合显示。
LAYOUT-02：顶部保留导航、搜索、岗位身份、退出；当前一级菜单蓝色强调线/淡蓝底选中，区别于浏览器或视频字幕。
LAYOUT-03：组织管理、文档管理继续左树右内容双栏。左栏默认约 280px，可调范围 240–360px；调整后右栏自适应、表格不会被遮挡。视频要求的树、成员卡、工具栏、文件表信息结构不可删减。
LAYOUT-04：右内容区包含页标题/面包屑、主工具栏、数据列表/成员卡；主要文件表适合工作场景的紧凑行高 42–48px，工具栏控制高约 34–38px，避免不必要的巨大空白卡片。
LAYOUT-05：使用 8px 基础间距体系，子级可 4px；主要区块间距 16–24px，卡片圆角约 12px，输入/按钮圆角 8px；不采用过度圆润的 24px+ 胶囊全面覆盖。
LAYOUT-06：面包屑过长时中间折叠且可展开；全局搜索可窄化但不能挤掉当前页面名称和基本操作。
LAYOUT-07：1366×768 下如果操作按钮容纳不下，优先把低频动作收纳到明确“更多”菜单，保留上传/新建、常用文件操作、筛选/统计/导出入口。不能把重要功能直接 display:none 丢失。
LAYOUT-08：右表格至少保证文件名、大小、上传人、修改时间；横向空间不足可滚动表格容器，但不缩到字段被文字截断而无法查看完整信息。
LAYOUT-09：点击/触控目标应尽可能不小于 24px×24px，常用工具栏按钮采用 32px 及以上易点中区域；键盘焦点有蓝色 focus ring。不得用只有颜色变化的小点作为完整交互反馈。
LAYOUT-10：中文优先 UI 字体，数字日期/文件大小用 tabular-nums；纯文本文件和代码内容采用等宽字体，文档展示不会因为统一 UI 字体而改变源文件语义。

#### 11.5.4 各页面视觉与交互约束
PAGE-VIS-01 登录：浅蓝白背景、居中白色登录容器、官方 Logo 原样等比、企业名、明确的用户名/密码标签和深蓝主按钮。允许极浅装饰性几何纹理，不出现第三方品牌/网页动态特效。
PAGE-VIS-02 文档管理：左树可见高亮蓝色矩形选中态，右列表白色表头/淡分隔线；文件夹 SVG 黄、操作 SVG 蓝灰；锁、审批用图标+文字标签表示；工具栏以紧凑蓝白风格呈现。
PAGE-VIS-03 组织管理：与截图保留左树右成员卡，左侧高亮市场部、右侧岗位成员卡；成员卡白底细边，交互选中蓝框，头像使用本地 SVG（不是用户肖像也不是 emoji）。
PAGE-VIS-04 文件预览：顶部只显示必要元数据和授权动作；DOCX 阅读器内原文档字体、色彩不受主题 CSS 污染；文本按 Plain Text-B 的原文保真规则显示。
PAGE-VIS-05 DOCX 编辑：品牌 Shell 和返回栏沿用 UI token；文档引擎内部 Ribbon 允许遵循其真实原生设计，不用全局 CSS 暴力覆盖 iframe 导致编辑不稳定；“保存中/已提交/待审批/冲突”必须在 Shell 中明确展示。
PAGE-VIS-06 CAD 3D：工具栏、零件树、参数信息使用品牌蓝白；模型画布可中性浅灰或深蓝灰以突出实体边缘和透明度，但不得将 STEP/GLB 的真实材质强行调蓝；视图控件使用一致 SVG。
PAGE-VIS-07 2D DXF/DWG：工具栏明亮清晰，黑/深灰/白画布由图纸自身背景和对比需求决定；尺寸标注与图层颜色必须保留，不准被主题颜色覆盖。
PAGE-VIS-08 版本历史：timeline/表格用蓝色强调当前版本；Append-only 回滚来源在版本 vN 的副标题可读，不得用旧版“删除后续记录”文案。
PAGE-VIS-09 审批：待审、通过、拒绝、冲突状态各有可辨图标/文案；危险审批操作需明确提交影响版本，蓝色按钮不能掩盖危险副作用。
PAGE-VIS-10 回收站、共享、关注：共同使用 FileTable、筛选器、空态、Toast 体系；身份/权限不足时不显示未授权数据；共享失效不应以红色整行背景恐吓用户。
PAGE-VIS-11 统计：允许以品牌蓝/深蓝与少量中性对比色绘制折线、条形或类别图；必须有图例、数值、单位、颜色无障碍替代文本，不以同色深浅作为唯一类别标记。
PAGE-VIS-12 导出：弹窗蓝白简洁、范围和字段描述清楚，危险 CSV 公式字符转义后台实施而不是让图标颜色承担安全性。

#### 11.5.5 图标、插画、动效与内容边界
ASSET-UI-01 全部系统操作图标使用项目本地内联 SVG，线条图标视觉上统一 stroke 约 1.75–2px（在 20px 框架内），尺寸优先 16/18/20/24px；图标必须有 aria-label 或相邻文本。
ASSET-UI-02 官方 Logo 是单独的真实品牌图片资产，不受操作图标“全 SVG”的限制；不能用字体/emoji 复刻抽象 Logo。
ASSET-UI-03 文件夹图标保留暖黄色，TXT/DOCX/STEP/DXF/STL 等文件可使用基于图标形状的小类型标识或标签；品牌蓝用于交互而不是把所有文件一律涂成蓝色。
ASSET-UI-04 默认不采用装饰性大型插画或虚构机械工程照片；无数据空态以简单蓝灰 SVG + 文字 + 可执行动作代替占屏幕一半的宣传插画。
ASSET-UI-05 动效仅用于 hover、菜单展开和 150–200ms 以内的内容状态转移；遵循 prefers-reduced-motion，禁持续闪烁和复杂视差。
ASSET-UI-06 3D 模型本身的转动、加载进度属于产品功能动画，不受 200ms 常规 UI 动效限制；仍须可以停止并在错误时恢复。
ASSET-UI-07 文件内容里可以有 emoji、HTML、Markdown 等，Plain Text 模式必须按原文显示，不把主题 SVG 规则应用到用户内容。

#### 11.5.6 一致性检查和验收案例 VS01–VS18
VS01 官方 Logo 资源完成可信导入并按实际 JPEG 哈希校验；登录、顶栏、favicon 清晰且未变形。
VS02 亮蓝/深蓝与 Logo 风格一致，主体采用白/浅蓝白，中性文字易读；不出现旧书本 Logo、云朵 Logo 或旧灰白整站皮肤。
VS03 token 通过静态检查，主按钮、文字、选中高亮、focus、border 使用同一 token，不产生页面级随机蓝色。
VS04 1440×900、1366×768、1920×1080 三种桌面视口下无导航、表格、工具栏互相遮挡。
VS05 文档管理左树/右表保持截图关系，选中目录后内容与面包屑对应。
VS06 组织管理左树/右成员卡保持截图关系，成员卡数量依真实种子而不是硬编码为 3。
VS07 主工具栏带 SVG 和文字，权限不足禁用有原因；窄屏的“更多”菜单真实可打开并执行受权功能。
VS08 DOCX 编辑器 Shell 蓝白主题与系统一致，编辑引擎内格式不受外部 CSS 覆盖，提交/待审状态清楚。
VS09 CAD 查看器中模型真实材质、单位、零件层级与画布对比充分，系统控件仍统一蓝白。
VS10 文件夹黄色 SVG 可辨、文件类型 SVG 一致；没有 emoji 冒充 UI 图标。
VS11 登录、组织、文件、审批、回收站、共享、关注、统计页面的字体/按钮/输入一致。
VS12 普通正文与背景对比 ≥4.5:1、大标题与功能性状态控件 ≥3:1。
VS13 键盘 Tab 顺序、focus ring、Esc 弹窗、loading/empty/error/success 一致可操作。
VS14 长中文文件名、长路径、窄屏工具栏、过期分享和含特殊字符文件名不破坏布局。
VS15 CSV 导出表单、审批确认、删除确认均采用统一 Modal 外观但危险说明明确。
VS16 图表类型颜色和标签可理解，无权统计范围不以 UI 错误泄漏敏感总数。
VS17 文件纯文本区为等宽字体、行尾/Tab/空白语义保真，不能因品牌 CSS 换行而改变文件字节。
VS18 检查品牌页面截图时必须固定测试数据、角色、路由、选中对象、视口与缩放；排除视频字幕、播放控件和浏览器框。不以像素相似度代替功能通过。
每个 VS 用例保存 screenshot + route + role + viewport + token 版本 + accessibility 报告 + PASS/FAIL。
VS01–VS18 属于首期品牌验收，附加在 S13/S20，不可被“已经有 CSS 文件”代替。


---

## 12. Seed、开发运行与迁移兼容

### 12.1 开发数据世界
公司：中晟生物科技。部门：市场部、研发部。
管理员：admin / 系统管理员（初始口令仅供隔离开发环境使用）。
普通角色：1000001 市场部文员、1000002 市场部主管、
1000003 市场部专员、1000004 研发工程师、1000005 项目经理。
工作组：市场部工作组，初始成员 1000001/2/3。
目录：公司文档/市场部/市场资料；公司文档/市场部/活动素材；
公司文档/研发部/技术文档；公司文档/示范项目/项目预算。
授权场景：工作组基础 list/preview/upload；
主管与专员追加 download/modify；研发工程师不可看市场部；
项目预算需项目经理审批；另含 scope_only、限时 ACL 的测试对象。
文件：用于 DOCX 标题/段落预览的标准 docx、用于视频 seek 的有效 MP4、
真实 PNG、预算 TXT、研发 Markdown、代码类文件和 Plain Text 回归 fixture。

### 12.2 新增五项种子状态
TrashSeed：一个被删除的 TXT、一个含子目录的软删除文件夹；
另含“原父目录已删除”和“恢复与同名冲突”的单独隔离夹具。
SharedSeed：内部用户接收文件共享、工作组接收目录共享、一个已过期共享、
一个撤销共享、一个接收方权限变化的测试。
FavoritesSeed：普通用户关注可访问文件和目录；一条资源删除/失权的展示用例。
StatsSeed：跨两部门不同文件大小和类型，有可预测的数量/容量/月份，
验证普通员工与 admin 聚合结果不同。
ExportSeed：文件名含逗号、双引号、CRLF、中文和 = + - @ 开头的公式危险内容，
以便核实 CSV 规范、BOM 和防公式注入。
这些 Fixture 的确切主键、预期字节和 sha256 应由种子程序生成后保存在测试清单；
不允许测试读取当前数据库状态“猜 expected”。

### 12.3 Seed 安全边界
本节 DEV/TEST seed 不用于正式库；首装流程以 §12.4 为准。
filesmanage --seed 只能对显式 TEST/DEV 环境执行；
若 DATABASE_URL 指向生产或缺少显式 seed token，应拒绝。
默认不删除已有数据；可用 --reset-test-data 在一次性的测试数据库内重建。
历史 Node 的 data/filesmanage.db / WAL / blobs 只读保留，禁止复用新 PostgreSQL seed 程序清理。
### 12.4 全新初始化决策（DEC-15 / RESOLVED-04）
INIT-01 用户决定全新开始。新版不迁移 Node/SQLite 的用户、组、部门、ACL、文件、版本、审批、会话、口令、文件 Blob 或任何业务元数据。
INIT-02 使用独立创建的 PostgreSQL 数据库/DB 账号、新 BLOB_DIR、新初始化 IDs；强制拒绝路径与旧 SQLite/blob 目录重叠。旧数据保留作独立历史归档，未获删除授权不得物理清理。
INIT-03 新公司“中晟生物科技”从零生成岗位身份、部门、组、目录树、授权、真实 DOCX/视频/TXT/CAD 样本，以及回收站/分享/关注/统计/导出的全新初始场景；不得照搬旧业务记录。
INIT-04 区分新 PostgreSQL schema migrations（首建、后续升级）与已取消的旧 SQLite 数据 ETL。schema migrations 必须持续保留，不能因为不迁移旧数据而省去 DDL、FK、备份与回退。
INIT-05 实际生产 bootstrap 与 DEV/TEST seed 分开：受控 bootstrap 只在经核实的空新库执行一次，创建管理员与基本组织；bootstrap-demo 显式启用才添加安全演示文件。不得对非空库重复清表。
INIT-06 管理员首次口令由安全部署输入或 secret 产生，不沿用旧版口令、不把 demo 默认密码写入仓库，首次登录强制修改；测试攻击性 fixtures 不进入正式库。
INIT-07 初始化步骤具备幂等/恢复、执行版本记录、Blob checksum manifest、失败补偿与空库校验；服务重启或 redeploy 不会重置新创建的账户或文件。
INIT-08 验收需证实新旧数据库路径隔离、初始数据全部为新生成、旧目录未写/未删除、新 Postgres 重启后数据持久化。旧 Node 49/49 是行为参考，不是新数据导入证据。
INIT-09 用户说“旧的都不要”是“不带旧数据到新系统”，不代表授权清除旧磁盘文件；物理清理需要另外明确目标和确认。

Node 49/49 是历史通过记录，当前未重新执行；新系统不要通过修改旧脚本改写基准结论。
本期明确无 Node/SQLite 数据导入或 ETL；仅须新 PostgreSQL schema 创建与后续迁移版本升级。

---

## 13. 自动化测试矩阵与 DoD

### 13.1 测试层级
T0 纯函数：ACL 继承/并集/过期/仅本目录、CSV escaping、UTF-8/BOM/EOL 识别、
版本 seq、目录祖先链、状态迁移合法性、审批策略选择。
T1 PostgreSQL 集成：真实 migration、FK、事务回滚、并发锁、审批双击、
版本回滚、孤儿 blob GC、共享失效、回收站恢复。
T2 HTTP 契约：Gin 错误码、API JSON 字段、Cookie、安全响应头、权限矩阵。
T3 React 组件：路由与深链、对话框、按钮状态、树选择、审批列表、空态和 CSV。
T4 端到端业务流：多个账号、浏览器、真实 blob、文本 checksum 和数据库副作用。
T5 远程环境：PostgreSQL、systemd、浏览器访问、备份恢复、S1–S13。
每层有机器可读结果和可定位的失败用例，不能只贴一张“测试通过”截图。

### 13.2 旧 S1–S13 的新基线
S1：admin 登录成功、错密 401、未登录 401、会话过期/吊销、me 返回待审数。
S2：真创建组并加入多个成员，去重和越权操作；组卡片与数据库一致。
S3：工作组授权基础动作，主管可访问目标目录和上传。
S4：两用户直接 ACL 追加 download/modify，权限并集且父权限保留。
S5：研发工程师无权市场部，树/搜索/预览/raw/download/导出均不可见。
S6：DOCX、MP4、PNG、PDF、TXT 基础预览和 MP4 Range/206；模型格式完整预览在 S22 验收，不用提示页代替。
S7：有锁者编辑，其他人获 409+锁主；未签入内容只被锁主可见。
S8：审批拦截、申请、待审、通过/拒绝、版本变化、最终锁释放和已通过状态。
S8b：无审批目录上传 v1→编辑签入 v2→选择回滚 v1→新增 v3(action=rollback,内容=v1)，保留 v1/v2/v3 三条历史；再次修改产生 v4。
S9：中文预算等词检索、mark 安全摘要、tsvector/like、过滤、毫秒报告。
S10：限时 ACL 在边界时刻生效/失效；以注入时钟测，不必硬等 61 秒。
S11：组织树、用户列表、组成员管理和权限拒绝。
S12：远程 URL 可达、systemd 开机自启、升级/回退演练。
S13：Logo 驱动的品牌蓝白 tokens、SVG 操作图标、黄色文件夹图标、分层依赖与 VS01–VS18 页面视觉/无障碍回归。

### 13.3 第一阶段新验收 S14–S19
S14 回收站：单文件/文件夹软删除、被删除资源不可访问、恢复保持版本、
同名冲突、权限拒绝、永久删除前二次确认、GC 不误删活跃 blob。
S15 共享文档：内部用户/组共享、动态成员调整、过期、撤销、继承子目录、
禁止授予自身未拥有动作、分享后搜索、跨部门访问与脱敏路径。
S16 我的关注：关注/取消幂等、跨页面状态同步、列表排序、失权/已删展示、
账户隔离和重启持久化。
S17 统计：文件数/目录数/容量、类型聚合、最近新增、时间筛选、授权差异、
trash 排除与结果稳定性；禁止用无权数据推断统计。
S18 导出：中文 UTF-8 BOM CSV、引号/逗号/换行正确、防公式注入、
当前筛选一致、权限过滤、部分数据大文件处理与安全下载头。
S19 Plain Text：固定字节夹具 PT01–PT12、修改回滚 checksum、
文本截断、非法编码拒写、HTML 字面安全、并发旧版 409。

### 13.3.1 Append-only 回滚专项验收 RB-T01–RB-T12（必须通过）
RB-T01：v1(A)、v2(B)、v3(C) → 回滚 v1；断言 v4 新增且 SHA(v4)=SHA(v1)，v1/v2/v3 完整保留。
RB-T02：GET versions 的 seq 为 1,2,3,4，v4.action=rollback、targetSeq=1、fromSeq=3，旧版本作者与时间不变。
RB-T03：下载 v1/v2/v3/v4 分别得到 A/B/C/A；旧版本 blob 的 SHA 与创建前一致。
RB-T04：继续从 v4 编辑产生 v5，再回滚 v2 产生 v6；历史 1..6 无缺口，seq 永不复用。
RB-T05：没有 modify、没有持锁 token、锁过期、expectedCurrentSeq 不匹配分别被阻止，没有新增版本。
RB-T06：两个用户并发保存/回滚，使用事务/CAS 最多成功一个；不会重复 seq 或丢失已提交内容。
RB-T07：审批目录回滚先 pending，普通预览与下载/搜索保持旧 current；批准才追加新版本。
RB-T08：审批拒绝、重复审批、旧基准版本申请失效，均不生成异常重复 rollback 版本。
RB-T09：相同 idempotencyKey 重放 HTTP 请求返回相同版本或审批 ID；不同合法操作可以创建新的回滚版。
RB-T10：TXT/BOM/CRLF、DOCX 与 STEP/IGES 的回滚后字节 SHA 等于目标版；全文索引与机械派生指向新 current。
RB-T11：历史 model_derivatives、DOCX 和审计不可因回滚而清空；引用相同 blob 时垃圾回收不能删仍在使用的对象。
RB-T12：软删除文件、目标版本跨文件、目标版本不存在、仅查看者回滚和恶意旧 {seq} 请求均被拒绝；
         UI 确认文案写“新建回滚版本，保留全部历史”，不显示“删除后续记录”。
每项应提供：文件 ID/版本序列、事务日志/SQL 查询、HTTP 状态、正文/源字节 checksum、
可见历史截图、审批与锁状态、模型派生 ID、测试用例 PASS/FAIL。不得以 49/49 代替。


### 13.4 安全和故障注入场景
A/B 同时请求编辑锁只能有一方成功；不持有锁 token 的 Save 不能成功。
A/B 同时审批只能写一个版本；重复同一请求不会产生两个新版本。
文件软删除后向原 id 下载必须失败；恢复同名不可覆盖另一个文件。
共享在权限撤回后不可用；被移出工作组的账号下一请求立即失权。
SVG 及 HTML 上传后在 preview/raw 里不能执行脚本；CSV 导出不执行公式。
数据库连接断开、磁盘写满、blob checksum 错误、Gin 超时、浏览器刷新时，
成功/失败状态准确且不会有“成功响应对应不可读取内容”。
故障注入完成后检查 blob 孤儿数量、版本唯一性、pending 数、锁一致性和审计。
对关键危险 SQL 执行 EXPLAIN/性能检查，但不得为优化牺牲权限正确性。

### 13.5 测试环境隔离
每个可写集成测试使用临时数据库 schema 或独立数据库、独立 BLOB_DIR；
不得连目标机生产 DATABASE_URL 运行测试。
测试结束自动清理，失败时提供可供调查的隔离日志与请求记录；
禁止清理原 Node data 目录或其他用户环境。
构建期间的 fixture 音视频文件不需要进入生产 binary 的全部静态资源，除非 seed 明确需要。
CI 门禁：go test/race 适用范围、go vet、go build、tsc、vite build、
migration dry-run、HTTP 合约、关键浏览器 E2E 及独立安全用例。

---

## 14. 性能、可观测性和运维

### 14.1 性能总览（验收合同以 §24 为准）
本段提供监控与运维概览；**可重复数据集、p95/p99、并发、文件流、DOCX/CAD 资源隔离、性能回归 Gate 统一执行 §24 和 PE01–PE18**。不得只按本段的“低于几秒”等说明宣布高性能。
普通文件夹（最多几百项）分页首屏可交互以 2 秒为初步目标；
搜索首屏在种子数据集下应明显低于数秒，但不能把视频示例 0.0076 秒设为稳定 SLA。
文件预览、大文件上传、MP4 播放按文件大小与网络条件测；
必须支持 Range/seek 和流式读取而不把全部视频读入 Go 堆内存。
服务响应要包含 requestId，记录耗时、路由、结果码与可归因错误；
不记录原始搜索敏感文本、文件正文、凭据。
PostgreSQL 池设置 maxConns、maxIdleTime、connectTimeout；
真实并发下观察锁等待、阻塞查询和事务长度，避免长事务包住缓慢文件 IO。
需要可监控的健康检查 /health/live 与 /health/ready；
ready 失败时不向负载系统伪报数据库已经健康。

### 14.2 数据备份和恢复
备份至少为 PostgreSQL pg_dump + data/blobs 两个一致性集合；
须记录 schema 版本、数据库快照时刻、blob manifest/checksum。
恢复演练要求从备份恢复用户、ACL、文件、版本、回收站、共享、关注和审批状态，
抽样比对可下载内容 SHA-256。
不能只有“backup.sh 成功退出”就判备份可用；至少做一轮测试环境 restore。
GC 只能清理没有引用且超过安全保留期的 blob；
禁在事务尚未提交或备份正在捕获时删除仍需恢复的数据。
生产业务回滚采用 DEC-13 Append-only，原始签入版本与新回滚版本均保留；此版本历史规则不能混同于 pg_dump/blob 的灾难恢复或经单独授权的永久删除。

### 14.3 部署规程
Step A：检查目标机 PostgreSQL 版本、磁盘空间、Go 二进制架构、8091 当前服务。
Step B：数据库和 blobs 备份、验证 manifest 和恢复步骤。
Step C：构建 web、校验 Vite dist、复制到 embed 资源包、go build。
Step D：隔离端口/隔离 DB 启动新服务，测试登录、权限、Plain Text、视频、五新增功能。
Step E：执行版本化迁移 dry-run 和兼容检查；生产迁移前明确停写窗口。
Step F：按经确认的切换/回退计划变更 systemd；检查 /health/ready、401、安全 header。
Step G：远程浏览器真实验收 S1–S22（以及 PT/DO/MC 字节和格式样本）；保留旧版可回退工件、日志和迁移前快照。
如迁移不可逆，回退不只是重启 Node，还需要数据库恢复方案；
缺失这个方案必须阻断切换。
生产数据库密码、session secret 和其他凭据来自受保护环境文件或密钥管理；
不写入 repo、SPEC 示例实际生产环境或 systemd world-readable 参数。
### 14.4 新旧数据域切换与回退（DEC-15）
CUT-01 新 Gin/PG/BLOB_DIR 在独立端口或隔离环境验收，确认后才切换 8091；旧 Node/SQLite 只作不导入的历史归档。
CUT-02 切换前分别备份旧数据作安全保全（不迁入）、新 PG + blobs 作一致性快照并实际演练恢复，保存 systemd/代理和配置快照。
CUT-03 切换新系统后，旧 Node 的账号、文件和历史不会自动出现；用户看到的是新初始化数据。禁止虚构旧记录的延续。
CUT-04 如旧版切换窗口仍可写入，新写入不会同步到新系统；切换方案需明确旧系统停写/只读状态并向相关使用者说明。
CUT-05 回退至旧 Node 只是入口与服务回退，不会把新 PG 的增量资料复制回 SQLite。新版正式运行后若有新文件或审批，回退前先停写并保全新库，不得无声丢数据。
CUT-06 deploy.sh/rsync --delete/systemd 的操作只覆盖经批准的新构建工件，绝不删除或复用历史数据库/blobs 路径。
CUT-07 新库后续 schema upgrade 仍需 migrations、备份、回退与真实 PostgreSQL 检验；SQLite→PG ETL 和旧账号 checksum 对账明确排除本期。


---

## 15. Build 任务重排与交付证据格式

### 15.1 推荐由风险驱动的垂直切片
B0 基线冻结：原 Node/SQLite/blobs 和证据文件隔离归档；DEC-15 新 PostgreSQL、新 BlobDir、受控 bootstrap 替代旧数据迁移决策。
B1 约束设计：可执行 PostgreSQL migration、ACL/共享/审批/删除状态机、OpenAPI/Go/TS 一致模型、§23 层间依赖静态检查、§24 负载数据集/验收预算，以及 Office/CAD 独立隔离 PoC。
B2 最小链路：Go + React 登录 → 目录树 → ACL → Plain Text 预览和下载 checksum。
B3 文件生命周期：上传、移动、软删/恢复、版本和 blob 一致性。
B4 协作闭环：取锁 → 编辑 → 待审 → 审批 → 版本和锁状态。
B5 预览检索：DOCX、视频、图片、PDF、文本、中文全文和摘要安全。
B6 首期新增：共享文档、我的关注、统计、导出列表的完整前后端闭环。
B7 组织及 UI：成员卡、权限对话框、桌面布局、所有页路由与错误状态。
B8 质量门禁：Plain Text checksum、并发/越权/回收站/CSV、Go/TS 编译、AG01–AG16 架构 CI 与 PE01–PE18 性能指标，失败不得自行降低门槛。
B9 隔离部署、远程 S1–S22（含 DOCX 编辑引擎与 CAD Worker）、备份恢复和最终切换。
完成某切片的依据是可运行 UI + API + DB + 测试，不是目录里出现文件名。
原先九项任务可映射到这些 Gate，但不能继续把“先写完所有 store 再补测试”当默认路线。

### 15.2 工程交付 checklist
[ ] SPEC 中所有 OPEN 的 P0 条款已经业务确认，并写入决策日志。
[ ] 每个新增 endpoint 有 schema、权限要求、状态码和用例。
[ ] 每个新增数据库表有完整约束、migration 和逆向/备份策略。
[ ] 视频时间轴中每个核心场景有对应交互验收材料。
[ ] 组织与文档页图片基线可以在固定测试数据中重现。
[ ] 文件 Plain Text 至少 12 个夹具字节检查全部通过。
[ ] 回收站、共享、关注、统计、导出列表在真实 DB 中完整可用。
[ ] 多人锁竞争、审批重复提交、回滚与删除的状态没有竞态。
[ ] 下载和搜索不能越权，上传恶意 SVG/HTML 不执行脚本。
[ ] Node 历史版、它的数据目录与 49 项基准脚本未被新 Build 篡改。
[ ] 生产替换前已进行备份和恢复演练，并有回退操作记录。
[ ] 没有以部分通过的测试替代 S1–S22、PT01–PT12、DO01–DO14、MC01–MC18 总体验收。

### 15.3 每项开发任务完成证据
任务号、Git/目录快照、对应 SPEC 段落、API 路径、DDL 迁移版本、测试命令、
测试输出、构建工件哈希、截图、风险、已知限制和下一依赖。
失败的测试必须原样报告，不得删断言凑“全绿”。
提交给用户的状态必须说明：已写文件、已编译、已运行测试、已远程验收是不同阶段。
如果一项功能缺少负面测试，最多宣称“基本流程演示成功”，不能宣称“正式完成”。

---

## 16. 决策记录、验收争议与未来变更

### 16.1 当前已定事项
2026-10-08：Go Gin；PostgreSQL/pgxpool；React 18 + TypeScript/Vite；
Browser Router；浅蓝白 CSS token + 文件黄色内联 SVG；
企业主体中晟生物科技；岗位身份；原 Node 参照版不改；
第一期回收站、共享文档、我的关注、统计和导出列表完整交付。
后续经用户明确确认：
- 蓝色图形标志为正式 Logo，项目必须导入原始资产并保留源文件；
- 必须真实在线编辑 DOCX，并把修改持久化为可下载的 DOCX 新版本；
- 业务核心是机械设计，必须支持常见中性机械 CAD、网格及 2D 图纸在线预览；
- 不能因新范围扩大而删减原 ACL、版本、审批、Plain Text、视频场景。
视频原素材已取样复核并保存 VIDEO-EVIDENCE-v2.1.txt；
取样是时间戳证据，不代表每一秒已经完整转录。

### 16.2 必须裁决与必须验证
RESOLVED-01 / DEC-14：用户选择官方 Logo 的现代蓝白工业科技风；原视频只保留信息架构、页面操作和业务行为作为对照，视觉验收按 §11.5 和 VS01–VS18。
RESOLVED-02：DOCX 在线编辑是真正的 .docx 格式持久化，不可再退回 Plain Text 或只读；实现见 §19。
RESOLVED-03 / DEC-13：用户选择完整 Append-only 回滚，历史版本不删减；协议、状态机、审计和验收以 §7.5 为准。
GATE-DOCX：文档编辑服务的合法授权、目标机性能、回调安全与真实 DOCX 格式测试须通过。
GATE-CAD：A 类 STEP/IGES/网格/DXF 格式真实通过、B 类 DWG 转换服务授权及 PoC 有明确结论。
GATE-BRAND：用户原始 JPEG Logo 必须可信导入项目并核对哈希。
其余 P1 决策可在 B1 约束设计阶段集中确认：兼容 URL、混合行尾保护、重复保存版本策略、
内部共享边界、正式截图视口。

### 16.3 规范变更机制
任何新要求必须记录 ID、证据来源、数据与安全影响、UI/API/DDL 变更、
回归用例、版本和签字状态；先改 SPEC 再改代码。
用户已经确认的功能不得在代理实施时自行降级；厂商依赖与许可证风险必须显式报 BLOCKED。
对原视频无法核实的文案和交互保留 UNKNOWN，不能凭猜测编造已交付的证据。
最终以经批准的 SPEC、可重复自动测试及现场验收的交集确定交付。

---

## 17. 审查结论和文档状态
本节是 §18–§25 新增前形成的阶段性概述，**最终审查与发布状态以 §25 和 SPEC-v2.1-ARCH-PERF-AUDIT.md 为准**。
本稿已经覆盖 C01–C25、S1–S22、Plain Text-A/B、真实 DOCX 编辑、
机械模型预览、权限与数据一致性，并与视频证据清单相互关联。
截至本稿：原 Node、SQLite data、原 SPEC.md 保持不变；
Go + React Build、引擎 PoC 和远程 S1–S22 尚未执行；
Logo、DOCX 和机械预览的业务范围已明确，但品牌原图仍待可信导入、
编辑器/转换服务部署与商业授权仍待核定；
产品业务方向已明确：DEC-14 Logo 蓝白视觉、DEC-13 追加式回滚、真实 DOCX 和机械模型。仍待品牌资产入库、厂商许可与独立引擎 PoC、视觉样本签收和技术契约验证。
不得把本稿状态标为 FINAL 或声称任何未执行验收已经通过。
发布门槛：DEC-14 品牌视觉按 §11.5 完成 VS01–VS18 签收、DEC-13 回滚用例通过，品牌原始资源可信入库，
编辑/CAD 依赖与许可证合法可用，schema/API/types 经过验证，
S1–S22、PT01–PT12、DO01–DO14、MC01–MC18 及备份恢复全部有实测证据。

---

## 18. 正式 Logo 与品牌资产交付 — C23

### 18.1 资产唯一性
BRAND-01：用户在本轮会话提供的蓝色抽象图形是正式品牌 Logo，必须取代演示视频里的旧书本符号与原 Node 的云朵图标。
BRAND-02：已观察原始附件为 JPEG、1080×1080、约 36 KB，白色背景、天蓝与深蓝渐变；原始 SHA-256 为 b307a0ab8ecdbd365afc75b322f97efb1b67777530d49bd7339dd17fa4592c21。
BRAND-03：官方附件必须可信入库为 assets/brand/logo-source.jpg 并核对哈希。2026-10-09 客户交付的附件 SHA-256 与 BRAND-02 记录一致，已可信入库为 `web/public/assets/brand/logo-source.jpg`；`scripts/brand_assets.py` 核对哈希并从原件派生 favicon 16/32/48px 与登录页/顶栏用 PNG（派生清单见同目录 `BRAND-ASSETS.md`）。登录页、顶栏、favicon 均已使用该资产；VS01–VS18 截图签收在远端验收执行。
BRAND-04：允许从原始 JPEG 派生 favicon 16/32/48px、登录页与顶栏用 PNG/WebP；保留原件，不用近似重绘的 SVG 替代。
BRAND-05：用户未明确授权前不可擅自消除白底、改变图形旋向、配色或渐变。深色顶栏需测试白底边缘与对比度，必要时单独签收透明版。
BRAND-06：“UI 操作图标必须内联 SVG”与官方 JPEG Logo 是两类资源；前者不能排斥后者。
BRAND-07：导航、登录页、帮助页、浏览器标签均以本地静态文件加载，不使用外部图片 URL；重启后资源必须仍能访问。
BRAND-08：品牌验收要存储原始 SHA、派生清单、截图和实际构建后的资源路径；本地出现一个文本路径并不代表真实资产已经交付。

### 18.2 品牌截图验收
BG01：登录页 Logo 等比例、清晰、无拉伸；公司名“中晟生物科技”显示正确。
BG02：主导航在 1366/1440/1920 宽度均不挤压、裁切或覆盖 Logo。
BG03：favicon 可识别；小尺寸不直接硬缩导致严重锯齿或模糊。
BG04：删除静态资源时展示可诊断错误并阻断“品牌验收通过”，不以旧 Logo 自动回退。
BG05：原 JPEG 哈希与用户原件一致；派生素材有可重放的转换脚本/参数。
BG06：第一期所有业务页面不混用两个不相关 Logo。

---

## 19. 真正可保存的 DOCX 在线编辑 — C24

### 19.1 功能验收与范围
DOCX-01：用户选择 .docx，拥有 modify 且文件 ACTIVE、无审批冻结时能够在线编辑。
DOCX-02：必须支持并保留基础正文、中文/英文、字体与字号、加粗/斜体/下划线、颜色、段落对齐、编号列表与项目符号、基础表格和内嵌图片。
DOCX-03：点击“保存并签入/提交审批”最终生成的是有效的 OOXML DOCX 二进制文件；独立 Word 兼容编辑器可打开并复查格式。
DOCX-04：不得用 contenteditable.innerText、HTML 字符串、导出 TXT 再改名 DOCX 或只读 iframe 冒充保存。
DOCX-05：原始每个版本的 blob 不可覆盖，需产生 file_versions 新版本并记录 SHA-256、大小、提交人、源版本与审批事件。
DOCX-06：宏、OLE、修订追踪、公式、复杂页眉页脚、特殊字体等需建立“保留/支持/警告/拒绝”清单；不能承诺每个 Word 特性像素级 100% 保真。
DOCX-07：.doc、.docm、.odt 不是本期原生可写目标；如需转 DOCX 必须“新文件”明确确认，不允许无提示覆盖源。

### 19.2 编辑器依赖和内网部署
首期优先集成自托管 ONLYOFFICE Docs Document Server（或通过同一组测试的等效方案），Gin 继续承担认证、版本、存储、审批与锁，React 只承载合法的编辑 iframe 和状态 UI。
Document Server 是独立服务，不能嵌在单个 Gin 进程中。部署计划必须纳入它的容器/服务管理、资源、端口、存储、内部依赖、备份和健康检查。
PoC 必须验证目标机 CPU/RAM/磁盘、许可证与并发上限、AGPL 或商业授权合规、内网地址访问、JWT 和 callback。
编辑服务不健康时允许预览/下载已批准 DOCX；不得显示“可在线编辑”可用状态。
官方技术资料：
- https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler
- https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file
- https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/co-editing
- https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/security/
- https://helpcenter.onlyoffice.com/docs/docs-community-sys-reqs-docker.aspx

### 19.3 编辑锁与会话
流程：验证文件 ACTIVE + modify → 事务内申请锁 → 建立 office_session → 生成安全文档 URL 与一次会话内稳定的 document.key → 初始化编辑器。
首期默认**文件级单写者模式**以兼容视频协作锁，其他用户可预览上次批准版本但不能加入未经审批的写入会话。
第二个标签重试、锁过期和用户退出都需校验 lock_generation 与 token；旧标签不可释放后来重新获取的锁。
document.key 在完成的编辑会话终止后换新；不要把 file ID 当永久 key，不然可能加载旧缓存。
Document Server 内部自动保存、系统“签入版本”、审核通过是三种不同事件。
关闭页面不保证 cancel 请求发出，必须通过服务端 TTL + 回调状态完成回收。

### 19.4 ONLYOFFICE 保存回调契约
官方 callback status 定义：
- 1：编辑连接变化，只更新会话活跃状态，不生成版本；
- 2：文档完成编辑、等待存储系统收取最终文件；
- 4：无修改关闭，不生成版本；
- 6：force-save 创建可收取快照，适于“保存并上传/提交审批”；
- 3 或 7：保存失败，当前版本不能更新。
用户点击保存只启动受控签入任务；**只有 callback + 下载校验 + DB 事务完成**才显示已生成新版本。
编辑器显示“保存中”直到从 Gin 查询到 committed/pending/failed；不能在发出 force-save 命令的响应返回 200 时误报“已签入”。
status=6 签入后重复收到 status=2，不得无差异重复创建新版本；回调幂等键与保存代次应明确。
force-save 并不自动成为 ONLYOFFICE 内部版本历史；filesmanage 的 file_versions 是权威版本账本。
若业务用户在一次会话确实提交了两个不同的快照，应区分 save_generation，不因简单按 session_id 去重而丢掉第二次修改。

### 19.5 回调鉴权、SSRF 和保存事务
Callback 每次验证 JWT 签名/算法、会话与 document.key 映射、允许的 document server 源；不信任任意 post body 中的 url。
对 callback.url 的文件下载必须限制到明确配置的可信编辑服务主机及端口，阻断任意重定向/DNS 重绑定/元数据地址及本地网络扫描；流式读取、大小上限、超时、ZIP bomb 检查。
先写 staging blob，校验 OOXML 结构和 SHA-256，再事务内校验锁会话、base_seq、modify、文件未软删除及当前 pending 策略。
无审批：签入 vN 并发布新 current；有审批：把文件变更放入私有 pending blob，current 不变；批准时重验冲突并签入。
拒绝审批时恢复普通编辑能力，不把未批准文件暴露给其他 preview 用户。
网络超时、callback 重放、status 乱序、编辑引擎重启后系统须能恢复保存状态，禁止丢失被编辑的新稿或覆盖新版本。
后台 API 保存 DOCX 仍然复用 audit、版本 seq 唯一约束、blob staging 事务规则。

### 19.6 数据库与 API 增量
office_sessions：id、file_id、base_seq、owner_id、document_key UNIQUE、lock_generation、status、created_at、expires_at、closed_at、last_callback_at。
office_save_events：id、office_session_id、save_generation、callback_status、payload_blob_id、event_hash、result、created_at、processed_at；保存代次和状态有防重放唯一约束。
office_compatibility_reports：file_id、version_seq、engine_version、supported_features、warnings、verification_status、created_at。
API：
POST /api/files/:id/office/session — modify+锁，建立编辑会话，返回安全编辑配置。
GET /api/files/:id/office/session/:sid — 仅会话持有者或受控管理员可读真实状态。
POST /api/files/:id/office/session/:sid/commit — 触发签入/审核流程，返回 pending job ID。
POST /api/files/:id/office/session/:sid/cancel — 有 token 的会话取消，清理策略明确。
POST /api/internal/office/callback — Document Server JWT 专用，接收回调，不依赖浏览器 Cookie。
GET /api/internal/office/source/:token — Document Server 短时源文件访问，版本和身份受控。
GET /api/files/:id/office/history — 按授权返回系统版本记录与可读的兼容性警告。
API 所有错误具有稳定 code：E_EDITOR_UNAVAILABLE、E_EDITOR_LICENSE、E_CALLBACK_INVALID、E_DOCX_INVALID、E_VERSION_CONFLICT 等。

### 19.7 DOCX 验收 DO01–DO14
DO01：中文/英文段落编辑，产出可重新打开的有效 .docx，旧版 SHA 不变。
DO02：加粗、斜体、字号、文字颜色、下划线重新打开后保真。
DO03：列表、段落对齐、多级标题变更，重开后与预期一致。
DO04：编辑复杂表格文本，图片与未编辑表格结构不丢失。
DO05：页眉页脚和分页符保留程度出兼容性报告，不符合目标必须明确失败。
DO06：长文档及多人只读访问时不越过编辑器资源上限。
DO07：A 正在改、B 只能读上次提交版本；B 取锁失败。
DO08：正常关闭与 force-save 的 callback 都能完成且不重复版本。
DO09：callback 乱序/重放/重启/签名错误都不能生成非法版本。
DO10：审批目录保存进入 pending，普通 preview 仍看旧版。
DO11：审批拒绝不产生新 current，锁和 pending hold 可恢复。
DO12：文件已删除/权限撤销/版本变化时迟到 callback 不能覆盖。
DO13：伪造下载 URL、跨域重定向、ZIP bomb 必须拒绝。
DO14：两个浏览器标签、锁过期和保存超时重试不重复签入。
每个成功测试产物含原始及新 DOCX SHA、Word 兼容打开截图、后端 version/approval/audit 证据。

---

## 20. 机械设计模型预览 — C25

### 20.1 格式承诺和能力分级
机械设计为本系统主业务，必须区分：工程中性几何格式、网格格式、2D 工程图、厂商专有原生格式。
A=本期强制在线预览通过；B=本期业务要求但受商业许可证/转换器 PoC 先决条件约束；
C=上传/下载/格式识别，若未有经授权的转换器则不能宣称在线查看。
仅显示“安装插件后可查看”不属于 A/B 的验收通过。

| 扩展名 | 级别 | 技术路线 | 验收要求 |
|---|---|---|---|
| glb/gltf | A | Three.js GLTFLoader | 层级、材质、关联纹理与资产安全 |
| stl | A | STLLoader | ASCII/Binary、法线、缩放、未知单位提示 |
| obj/mtl | A | OBJLoader/MTLLoader | 几何、材质、资源依赖 |
| ply | A | PLYLoader | 已支持的点/面/颜色 |
| 3mf | A | ThreeMFLoader | 多部件、基本材料与支持扩展 |
| step/stp | A | OCCT STEP reader + 网格派生 GLB | B-Rep 读取、单位、几何边界 |
| iges/igs | A | OCCT IGES reader + 网格派生 GLB | 曲面/实体与失败降级 |
| dxf | A | 独立 2D DXF 解析/渲染 | 图层、圆弧、尺寸文字 |
| dwg | B | 已获许可 ODA 类转换链 | 不同版本 DWG 与布局/字体样本 |
| x_t/x_b | C | 授权 Parasolid 解析器 | 许可/几何质量验证后升级 |
| sldprt/sldasm | C | 授权 SolidWorks 转换器 | 零件/装配/版本兼容 |
| prt/asm | C | Creo/NX 按原始签名分派 | 不得仅靠扩展名猜格式 |
| catpart/catproduct | C | 授权 CATIA 转换器 | 许可/装配映射 |
| ipt/iam | C | 授权 Inventor 转换器 | 许可/格式样本 |
| ifc/rvt | C | BIM 非机械重点 | 不计入首期在线预览成功项 |

DWG 的 B 类 Gate 需要明确预算、许可证、操作系统兼容与转换 PoC；未通过时首期机械格式支持保持 BLOCKED 而不是虚报全覆盖。
对 C 类格式不允许“后端收到扩展名就返回 ready”。
模型在线预览不表示机械模型可在线编辑或将 GLB 写回 STEP；原始工程文件必须原样留存和下载。

### 20.2 3D Viewer 交互
MOD01：旋转、平移、缩放、重置视角、适配模型、坐标轴、透视/正交投影、网格显隐。
MOD02：有装配信息时提供零件树、选中高亮、独立隐藏/显示、整体恢复和 bbox。
MOD03：显示来源格式、真实版本、源文件 SHA、单位、尺寸范围、组件数、转换日期和警告。
MOD04：STL/OBJ 无单位时显示“未知单位”，不能默认为毫米再错误计算真实尺寸。
MOD05：如果只拿到三角化网格，测量结果显示“近似”，不得宣称 B-Rep 精密量测。
MOD06：内嵌缩略图、loading/progress/ready/failed/retry/unsupported 状态明确，不能无限转圈。
MOD07：浏览器 WebGL 失效或文件太大时有可操作错误和允许的下载入口。
MOD08：DOM 层级和 URL 改变时需 dispose 三维纹理、几何和事件监听，避免内存泄漏。
MOD09：显示/隐藏动作只影响视图，不修改 source blob。
MOD10：待审模型不能对未获授权普通账号显示新几何，其他用户看到仍是当前签入版本。

### 20.3 2D 图纸
DRW01：DXF/DWG 至少绘制线、圆、圆弧、多段线、尺寸文字及图层；
DRW02：图层开关、模型空间、平移/缩放/适配视图可用；
DRW03：字体缺失、外部参照 XREF、复杂块/动态块应报告降级，不得隐瞒丢失；
DRW04：打印与原 print 权限挂钩，不能借转换派生直接绕过 download；
DRW05：转换器在受限环境运行，不执行不可信 LISP、外部脚本或从网络补 XREF。

### 20.4 转换 Worker 及资产安全
Gin 做鉴权/编排，独立 cad-converter worker 做 OCCT 解析与网格派生，React Three.js 负责绘制。
OCCT 把 STEP/IGES 读取为几何形体后按照明确弦误差和角偏差三角化；生成 GLB 等派生文件。
原始 STEP/IGES 字节不因预览而改变，三角化精度和原 CAD 几何精度要在 UI 中区分。
转换服务使用低权限账户、CPU/RAM/磁盘/超时配额和无公网访问的执行环境。
glTF 外部 bin/纹理，OBJ mtl/纹理必须经资源清单白名单加载，阻断任意 URL、../、绝对路径。
3MF/ZIP 容器必须检查 zip-slip/zip-bomb 与深度/数量限制，不能解包到项目代码目录。
模型衍生状态 queued -> running -> ready/failed/cancelled；重启后具备幂等重试及任务租约回收。
源文件与派生按 (file_id,version_seq,converter_version,settings_hash,kind) 关联去重，
回滚/软删/恢复/审批后选到正确的 source_version，不允许显示旧版本缩略图冒充新版。
分享撤销和预览权限过期后，manifest、几何内容、缩略图每个请求都要再次鉴权；
一次已交给用户浏览器的几何不能声称还能从其本地收回。
模型派生不可覆盖原 blob，GC 须确认没有版本、缩略图或审批引用。

### 20.5 数据表与 API
model_derivatives：id、file_id FK、version_seq、source_sha256、source_format、output_kind、
blob_id FK、converter_name/version、settings_hash、status、error_code、summary_jsonb、
created_at/started_at/finished_at；关键字段唯一约束、状态 CHECK。
model_conversion_jobs：id、derivative_id FK、requested_by FK、status、attempts、lease_owner、
lease_expires_at、last_error、created_at、updated_at。
model_assets：id、file_id、version_seq、attachment_role(texture/material/bin/xref)、
relative_name、blob_id FK、sha256；安全规范化相对路径。
model_components：派生 ID、组件 key、parent_key、display_name、bbox、units；
如以 JSONB 存储也要有 version 归属和有效性约束。
conversion_providers：provider_id、version、allowed_formats、license_state、enabled、health_status。
以上是逻辑表契约，真正上线之前须写 PostgreSQL 可执行迁移与 FK/索引/CHECK。
API：
GET /api/models/formats — 当前部署真实可用矩阵（不是静态“全支持”）。
GET /api/files/:id/model/status — preview 权限下获得转换状态。
POST /api/files/:id/model/preview — 创建/复用派生任务，幂等。
GET /api/files/:id/model/manifest — 按权限返回单位、bbox、零件树及派生清单。
GET /api/model-derivatives/:id/content — 每请求再鉴权，流式返回派生。
GET /api/model-derivatives/:id/thumbnail — 已授权缩略图。
GET /api/model-conversion-jobs/:id — 可见任务状态及面向用户的错误码。
POST /api/model-conversion-jobs/:id/retry — 有权限并受限流约束的重试。
文件预览可通过 /preview/:id 选择 renderer 再到 /model/:id；深链刷新必须可用。

### 20.6 供应商/解析器资料与许可证 Gate
Three.js 官方 loaders：https://threejs.org/docs/pages/GLTFLoader.html 、
https://threejs.org/docs/pages/STLLoader.html 、
https://threejs.org/docs/pages/OBJLoader.html 、
https://threejs.org/docs/pages/PLYLoader.html 、
https://threejs.org/docs/pages/ThreeMFLoader.html 。
Open CASCADE STEP/IGES 解析以所安装的 OCCT 对应版本文档与实际样本验证。
DWG 可评估 ODA Drawings SDK：https://www.opendesign.com/oda_online_converter ；
公开在线转换演示不等于软件可以未经授权在内网/商用产品里免费部署。
SolidWorks/Creo/NX/CATIA 等原生格式同理，必须取得合法依赖并验证厂商版本，
不允许把无法打开的原生格式当成“已通过支持”。

### 20.7 机械样本 MC01–MC18
MC01：STEP 单零件孔、倒角、包围盒与单位；
MC02：STEP 多组件装配树及显隐；
MC03：IGES 曲面件没有明显漏面和翻面；
MC04：IGES 不支持实体有清楚错误而不是空视图；
MC05：STL ASCII/Binary 正确显示且单位未知时提示；
MC06：OBJ + MTL + 纹理受控关联；
MC07：glTF + bin + textures 及 GLB 多组件；
MC08：PLY 受支持的点/网格类型；
MC09：3MF 多部件及基本材质；
MC10：DXF 图层、圆弧、尺寸/文字；
MC11：DWG 两种来源版本的许可 PoC，没有许可证判 BLOCKED；
MC12：超大装配受限制且不拖垮 API；
MC13：没有 preview 权限者无法取 manifest/content/thumbnail；
MC14：同版本并发请求转换任务去重；
MC15：版本切换、回滚、删除、恢复后派生与原 SHA 一致；
MC16：审批 pending 时普通用户看到旧版模型；
MC17：恶意纹理 URL、zip-slip、异常模型文件安全拒绝；
MC18：有授权的共享目录能查看对应模型，撤销共享后禁止新请求。
每条都要保留原样本、checksum、浏览器截图、几何/单位对照及 Worker 日志；空画布不是成功。

---

## 21. 新能力的系统边界、门禁与新增验收编号

### 21.1 原架构红线的必要调整
原 SPEC 的“仅 Go Gin/pgx 与 React/Zustand 等少量依赖”不足以支撑本次确认的高级格式。
本版本允许经审查的独立 ONLYOFFICE 文档编辑服务、Three.js loaders、
Open CASCADE worker 和有合法许可的 DWG 转换组件，但不允许未授权的外部云端数据传输。
编辑/转换组件不应被伪装成 Go 标准库内部功能；各自具备运行依赖、版本、健康检查、
许可证、备份、日志、限额、故障恢复和部署/回退步骤。
软件许可证/目标服务器资源不足必须明确呈报 BLOCKED，不得通过删验收项目实现“全绿”。

### 21.2 权限与版本联动
| 操作 | DOCX 编辑 | 机械模型查看 | 版本/审批结果 |
|---|---|---|---|
| 上传 | 原文档保留；等待编辑 | 保留原工程文件+派生 | v1 |
| 申请编辑 | File 级锁+office session | 仅查看不用取编辑锁 | current 不变 |
| 修改并保存 | 回调 + OOXML 校验 | 新源上传后重建派生 | 签入 vN 或 pending |
| 审批等待 | 新稿 staging 私有 | 新派生 staging 私有 | 其他人仍见旧版 |
| 审批通过 | 正式发布 DOCX | 公布新派生 | vN |
| 审批拒绝 | 原版不变 | 普通用户不见草稿 | 解锁/可恢复 |
| 回滚 | 目标历史 DOCX 字节作为新签入版本 | 新版本复用/建立对应历史 CAD 派生引用 | Append-only 追加新 seq，旧版本和派生全部保留 |
| 回收站 | 不再可通过普通页面编辑 | 不再可普通预览 | 原版本保留 |
| 分享撤销 | 每次请求校验 | 内容/缩略图再次校验 | 不改历史 |
所有文件均以 file_id + version_seq 精确绑定数据；索引内容、下载 SHA、
模型派生、预览、审批记录必须引用相同签入版本，禁止跨版本错配。

### 21.3 S20–S22 第一阶段新增验收
本章节的 S1–S22 是业务能力验收；另有 §23 AG01–AG16（架构）和 §24 PE01–PE18（性能）并列为发布阻断门禁，不能以 S1–S22 通过代替。
S20：官方 Logo 经可信资产入库，校验 SHA；登录页、顶栏、favicon 均正确加载且无变形。
S21：DO01–DO14，真正 DOCX 编辑+保存、锁/审批、回调、版本、服务不可用和安全负面用例。
S22：MC01–MC18，网格/中性 CAD/2D 图纸、合法 DWG、权限、版本及转换安全。
S1–S19 原验收不删减；PT01–PT12 文件字节保真仍需全部通过。
新技术容量由 PoC 在目标环境测定，不随意承诺“任意大文件、任何浏览器、无限并发”。

---

## 22. 本次决策记录与签收门槛

DEC-09：用户提供的蓝色图形是正式品牌 Logo。
DEC-10：第一期真实在线编辑 DOCX，并以 DOCX 新版本保存，允许使用独立自托管编辑引擎。
DEC-11：主要行业为机械设计，常见中性 CAD、网格文件和机械图纸须提供真实可验收预览。
DEC-12：回收站、共享文档、我的关注、统计、导出列表依旧第一期全部交付。
DEC-13：用户明确选择 Append-only 回滚：旧版本永远保留，回滚只新增一个带来源记录的签入版本（§7.5、§9.5、RB-T01–RB-T12）。
DEC-14：用户明确选择 Logo 驱动的现代蓝白工业科技界面；新视觉统一约束见 §11.5、VS01–VS18。
RESOLVED-01 / DEC-14：用户确定以蓝色官方 Logo 为品牌基准，采用蓝白工业科技风；严格保留视频的信息架构与可见交互，不复刻传统灰白皮肤。
RESOLVED-03：Append-only 回滚，保留全部历史，追加记录 targetSeq/fromSeq 的新版本。
仍待验证：可信 Logo 原始资产传输、编辑器许可/运行/回调 PoC、
DWG 转换许可证与目标机适用性、STEP/IGES 真实几何保真测试。
[ ] 原 Node、SPEC.md v2 与历史数据库原样保留。
[ ] Logo 源附件校验后入库，不使用替代图标。
[ ] DOCX 编辑器在目标环境真实启动，支持重新打开编辑后的 DOCX。
[ ] 14 项 DOCX 保存、审批、版本及回调反例全部通过。
[ ] 18 项 CAD 类型、权限、版本和安全样本全部通过或明确许可阻断。
[ ] S1–S22 及 PT01–PT12 的完整隔离测试报告保存。
[ ] 任何 §23 架构门禁、§24 性能门禁或审计报告 P0 问题尚未关闭时，文档仍为 DRAFT / 发布 NO-GO；PoC 和准备性工作不等于正式 Build。

---

## 23. 强制模块化分层治理（ARCH-GATE，第一期 P0）

### 23.1 架构定位与严格依赖图
ARCH-001：采用 Modular Monolith（模块化单体）+ 有资源配额的 Office/CAD 独立服务和后台 Worker。文件、权限、审批、版本的核心写入需处于同一 PostgreSQL 事务域，禁止过早拆为多个通过 HTTP 协作的微服务。
ARCH-002：分层以本章为准，§5.2 旧目录仅提供参考，不得以其较宽松文字覆盖本章。
依赖方向（箭头表示 Go import）：
    cmd/server/composition -> httpx, application, adapters, worker
    httpx -> application, domain
    application -> ports, domain
    adapter/postgres -> ports, domain
    adapter/blob -> ports, domain
    adapter/office -> ports, domain
    adapter/cad -> ports, domain
    worker -> application, ports, domain
    ports -> domain
    domain -> Go standard-library pure functions only
ARCH-003：禁止反向导入、循环依赖、service locator、init() 构造业务单例、全局可写状态。命令入口为唯一的 DI/配置组装根。
ARCH-004：application 内仅使用 ports 定义的最小接口，不能 import Gin、pgx、具体 blobfs、Office SDK、CAD SDK、HTTP DTO 或供应商错误结构。
ARCH-005：domain 定义不可变业务对象、权限动作和状态机，不能连接 DB、访问网络、读取环境变量或隐式获取当前时间；由 Clock port 注入。
ARCH-006：httpx 只做会话解析、HTTP 输入校验、序列化、状态码、流响应与 request ID。业务权限授权、事务、文件序列化、版本 seq 分配必须在 application 内。
ARCH-007：adapter/postgres 只处理参数化 SQL、索引、事务和数据映射，不负责解释浏览器路由和登录 Cookie；adapter/blob 只处理 staging、sha、流与回收，不自行决定文件读取授权。
ARCH-008：Office/CAD 适配器只封装外部协议与转换，不允许直接连接核心业务数据库，不允许绕过 application 创建 file_versions 行。
ARCH-009：若沿用 internal/service 和 internal/store 名称，可分别视为 application 与 adapter/postgres，但必须通过真实 import graph 与 AST 检查保证依赖，不靠目录名称宣称已经分层。
ARCH-010：端口接口仅为真实变更边界设置，纯函数不创建形式主义空接口；每个 use case 必须定义请求/结果、不变量、事务拥有者、错误码和测试 ID。

### 23.2 业务有界上下文和数据所有权
| Context | 拥有的表/业务记录 | 对外用例 | 不允许 |
|---|---|---|---|
| Identity | users, sessions, departments, groups, group_members | Login, Logout, ManageMembers | 用 SQL 直接更改文件授权 |
| Access | acls, management roles, permission revisions | ResolveEffective, Grant, Revoke | 在 React 中做最终许可判断 |
| Documents | folders, files, trash_entries | List, Move, SoftDelete, Restore | 直接 SQL 更新审批状态 |
| Versions | file_versions, current pointer, blob references | CommitVersion, History, Rollback | 删除历史以实现回滚 |
| Workflow | approval_policies, approvals, holds | RequestApproval, Decide | 从浏览器接受已批准的“结果” |
| Collaboration | edit_locks, office_sessions, callbacks | Acquire, Renew, CommitOffice | 以内存 mutex 替代数据库锁 |
| Sharing | shares, favorites | CreateShare, RevokeShare, Favorite | 无授权扩张他人访问范围 |
| Indexing | file_text, index jobs | IndexCurrent, AuthorizedSearch | 索引未获审批内容 |
| Reporting | stats views, export jobs | AuthorizedStats, StreamCSV | 无权限条件聚合全库数据 |
| Preview | model_derivatives, conversion jobs | RequestPreview, Manifest | 修改原机械模型 blob |
ARCH-011：跨模块事务由高层 application use case 编排多个 repo/port，所有写入使用相同 UnitOfWork；跨模块不得直接 import 内部具体 store 或调用本地 HTTP 形成分布式写入。
ARCH-012：跨上下文只暴露公开 use-case 接口，私有表结构不得被任意 context 的 handler 查询。对统计、搜索、共享内容调用统一可见性查询策略。
ARCH-013：每个聚合指定权威记录：File 当前指针、Version 签入链、Approval 待审状态、Share 授权状态、Office session、CAD 派生都有唯一事实来源；缓存不是新的业务权威。

### 23.3 事务边界、并发控制、文件系统一致性
TX-01：application 拥有 Tx 生命周期，所有参与一个业务提交的 repositories 接受同一个 Tx/UnitOfWork，不得内部重新向 pool 发独立写查询。
TX-02：不在数据库事务内执行上传完整 body 读取、blob 大文件 IO、Document Server 网络下载、CAD 转换或等待用户界面；先写 staging 并校验，再短事务进行 CAS、引用、审计、outbox。
TX-03：同文件写入统一锁顺序：folder -> file -> approval -> edit_lock/office_session -> version/current/outbox；若某场景不同，须 ADR 和并发死锁测试批准。
TX-04：所有有风险的写入以数据库条件更新（expected version/状态）和唯一约束保证无 lost update；业务回滚 Append-only，不得 SELECT MAX(seq) 后在无锁事务之外插入。
TX-05：在 metadata 事务内写 outbox_jobs，Worker 用 lease + attempt + idempotencyKey 处理，实际语义为 at-least-once delivery + 幂等效果。禁止声称 PostgreSQL 与本地文件系统有跨资源 exactly-once 原子提交。
TX-06：blob staging、publish、ready、GC 采用可恢复协议：可见 committed 记录引用可读 blob；任何 DB commit 与 rename 崩溃窗口必须可 reconciliation 恢复，不得给用户成功响应但文件不可读。
TX-07：跨事务 worker 不得直接更改 files.current_seq，只能调用受约束 use case；旧 Office callback / CAD 任务带源 seq 与 generation，迟到响应不得覆盖新版本。
TX-08：每次 mutation 有 actor、resource、requestId、idempotencyKey 与稳定结果；客户端重试同一 key 不得产生额外版本/审批/回收站条目。
TX-09：context.Context 贯穿调用；DB/网络/Worker 分别有明确 timeouts，失败 Tx 不复用，取消传到文件流与外部依赖。
TX-10：审批与共享撤销必须当次复验权限和基准版本；middleware 鉴权、客户端按钮禁用不能替代业务 service 授权。
TX-11：数据库 schema 必须有真实外键、版本复合唯一、审批 pending 去重、状态 CHECK、文件夹防环和幂等键约束；Go if 分支不能替代 DB 不变量。
TX-12：数据库事务失败必须做到数据原子回滚；外部 blob 失败以 staging/补偿/清理保证不产生幽灵资源与漏引用。

### 23.4 查询模型、缓存和内存治理
READ-01：权限统一由 VisibleResourceScope(userID, action, time, resourceContext) 定义；目录树、列表、共享、搜索、统计、导出、预览均复用同一规则；避免多个 SQL 路径各算一套权限。
READ-02：单 HTTP 请求可以缓存重复的授权判定；跨请求缓存须以权限修订版本/成员变化/分享撤销作为失效依据，授权撤销必须在下一请求生效，禁止“等 Redis TTL 结束才生效”。
READ-03：所有分页默认 50、硬上限 200；游标必须包含排序字段与资源 id；不能每条文件查询一次用户、版本、权限或目录祖先，避免 N+1。
READ-04：目录层级访问用有界 recursive CTE 或维护可事务更新的 closure/path 结构；不能每个树节点发一次 SQL。移动目录的大子树需要原子检查与可控复杂度。
READ-05：缓存键包含 resourceId、versionSeq、权限上下文版本和转换器版本；原文件/raw 默认 private,no-store。对共享撤销后已被浏览器下载的数据不能声称可远程撤回。
READ-06：上传、下载、MP4 Range、CSV 导出必须采用有背压的流式 Reader/Writer，避免 dataURL/base64 与完整文件 []byte 复制导致多倍内存峰值。
READ-07：统计必须先对授权资源过滤再聚合；导出流式逐批扫描而不是一次加载全部行；搜索的 total、snippet、page 均在权限过滤后计算。
READ-08：Office/CAD 重任务使用独立 Worker 限流/熔断/配额/队列，不得占满 Gin HTTP goroutines、PostgreSQL 连接池或业务请求 CPU。
READ-09：异常或慢查询必须通过 trace/query plan、索引和批处理优先优化；不能通过缩小鉴权范围或减少校验换取性能。
READ-10：后台任务停止/重启后支持恢复和重试，按稳定 job key 去重，队列水位高时拒绝或延迟新转换任务，而非 OOM。

### 23.5 前端单向依赖和状态所有权
WEB-ARCH-01：React 分层为 app -> pages -> features -> entities -> shared。只允许依赖下一层或受控公共底层；shared 不依赖业务模块、entities 不导入 pages/app、features 不导入页面路由实现。
WEB-ARCH-02：app 拥有 Router/Providers/全局 ErrorBoundary；pages 只组装业务 features；features 拥有操作 API/权限 UI/业务状态；entities 为可复用只读模型；shared 为稳定 HTTP、SVG、错误、基础控件和 token。
WEB-ARCH-03：features 按 documents/access/organization/sharing/workflow/history/reports/office/modelViewer 分域，禁止通过跨 feature import 内部文件互相耦合；共享行为由明示的公开门面完成。
WEB-ARCH-04：Zustand 只放会话摘要、目录选择、展开节点、选择集等 UI 状态；后端为权限、版本、审批的权威，不能在本地长期缓存正文和私有预览 URL。
WEB-ARCH-05：变更完成后按 use case invalidation 刷新相关实体；审批、回滚、共享撤销不允许乐观模拟“已正式成功”。
WEB-ARCH-06：HTTP fetch、上传 Blob、鉴权 header 拼装只能经统一 API client；组件不得私自调用 window.fetch 并跳过 API 错误/取消。
WEB-ARCH-07：大表必须分页，较长列表按需要虚拟化；WebGL 资源在组件卸载时 dispose，旧请求取消，不允许路由切换后旧权限数据覆盖新页面。
WEB-ARCH-08：tsconfig 开启 strict/noImplicitAny/noUncheckedIndexedAccess（新代码），循环依赖、跨层 import 违反依赖边界视为 CI 阻断，不是警告。

### 23.6 强制架构 CI 规则与审批流程
ARCH-CI-01：使用 Go AST/go list -deps 检查 import graph。domain 禁止依赖 Gin/pgx/httpx/adapter；application 禁止依赖具体 adapter/httpx；httpx 禁止直接导入 adapter/postgres；adapter 不导入 httpx。
ARCH-CI-02：静态分析禁止 handler 中 SQL/pgxpool 访问、application 中 SQL/磁盘路径直接拼接；人工抽查误报白名单须 ADR 记录。
ARCH-CI-03：使用 ESLint 边界与循环依赖检测、tsc --noEmit、vite build、Go go test/vet/build 和必要 race 测试。产生任何越层违规，CI fail。
ARCH-CI-04：每个 Endpoint 必须可追溯到 use case、domain action、port/repo、数据库事务或只读查询、错误码和测试 ID；空 handler/Mock JSON 不视为交付。
ARCH-CI-05：依赖升级需固定 Go checksum/npm lock、许可证审查、安全补丁、兼容测试、恢复预案；只有 composition root 能读取/注入生产密钥。
ARCH-CI-06：提供真实 import graph 报告和例外清单，例外写 ADR（风险、到期时间、负责人和移除条件），不得直接修改检测规则以使测试变绿。
ARCH-CI-07：公开生产服务不允许暴露未经授权的 debug/pprof/metrics/raw SQL。性能诊断端点必须走私有网络或严格控制。
ARCH-CI-08：以单项规则减少维护复杂性为目标；不为“看起来分层漂亮”添加多余接口和深层间接调用。

### 23.7 架构验收 AG01–AG16
AG01 domain import Gin/pgx 时检测失败；AG02 application import postgres adapter 时检测失败。
AG03 handler 直接访问 DB 时检测失败；AG04 前端 shared import pages 时检测失败。
AG05 service 用 fake ports 即可单元测试，不启动 HTTP/PG；AG06 Repo 集成测试使用隔离 PostgreSQL。
AG07 多表事务 SQL 错误后 current/version/audit/outbox 同时回滚。
AG08 blob stage 成功但 DB 失败时无可读幽灵文件；AG09 DB 提交/rename 崩溃后修复任务可恢复。
AG10 审批与回滚并发只成功一个写入、没有重复 seq/丢更新。
AG11 分享撤销后搜索、列表、统计、导出、预览所有读取下一请求失效。
AG12 CAD Worker 停滞/排队不能拖垮普通登录、列表 p95。
AG13 Office iframe 断线后锁和会话可根据 TTL 与 callback 机制恢复。
AG14 文件被修改和用户切换时旧前端请求不会错误覆盖最新状态。
AG15 新 API 具备 auth、service、port、repo、数据与负向测试可追溯记录。
AG16 向 Go/TS 注入真实越层 import，CI 失败；恢复合法依赖后才能通过。

---

## 24. 可量化性能与容量工程（PERF-GATE，第一期 P0）

### 24.1 高性能定义、测试配置与责任
PERF-001：“高性能”不能用漂亮动画、一次本地 curl 或视频录屏的毫秒数字证明。验收必须记录硬件配置、数据规模、用户权限分布、并发、请求分布、冷热缓存、p50/p95/p99、吞吐、内存、数据库和错误率。
PERF-002：以下数值属于 **拟议的第一期验收目标**，不是当前已实现成绩；在目标机完成容量 PoC 后若调整阈值，须经过独立性能 ADR 与用户确认，不能 Agent 自行放宽。
PERF-003：推荐独立基准环境参考配置：Gin + PostgreSQL 使用 8 vCPU / 16 GiB RAM / NVMe SSD / Linux x86_64，同内网客户端 RTT <= 15 ms，空闲 disk >= 25%。
PERF-004：ONLYOFFICE、CAD Converter 不得与上述基准主业务争用无上限 CPU/RAM；最好使用另外受控容器/节点，或同机用 cgroups 明确保留 Gin/PG 资源。若实际生产只有单台低配机器，PoC 报告必须用真实硬件重新确定能否满足首期范围。
PERF-005：正式生产预算还需测定 Office 并发会话、CAD 转换队列、数据库大小与源 blob 容量；这些尚未取得现场数据，不能对用户声称“无限文件、无限并发、任意尺寸模型均秒开”。
PERF-006：数据夹具同时包含正常用户/admin、少权限用户、组共享、跨部门 ACL、审批 pending、回收站、被撤销分享、1000 层内需拒绝的异常层级和复杂 CAD/DOCX；测试不得只用管理员账号绕过权限 SQL。

### 24.2 参考数据集（可重复生成，不涉及生产机）
| 数据项 | 基准规模 | 用途 |
|---|---:|---|
| 用户 | 1,000 | 登录、部门查询、共享、权限动态变化 |
| 部门和工作组 | 100 / 200 | 组织树与组授权 |
| 文件夹 | 10,000 | 递归树、目录移动、权限祖先链 |
| 活动文件 | 100,000 | 列表分页、全文检索、统计、导出 |
| 历史版本 | 400,000 | 当前指针、版本列表、Append-only 回滚 |
| ACL | 50,000 | 继承/叠加/仅本目录/限时过期 |
| 分享/关注 | 20,000 / 100,000 | 列表和动态授权 |
| 全文可索引文件 | 50,000 | 中文混排、权限过滤和排序 |
| 文件内容 | 10 KB–100 MB | 流式上传、Range、内存峰值 |
| 机械模型 | 10/50/100 MB 三档 | Worker queue、转换内存、派生 |
| DOCX | 1/10/50 MB 三档 | Document Server 并发、回调和格式保真 |
PERF-DATA-01：种子采用固定随机 seed，并输出 IDs、期望统计/授权结果、schema 版本、DB 行数、blob manifest 和 sha256；断言查询结果正确，不靠随机生成什么就认什么正确。
PERF-DATA-02：负载覆盖热点大文件夹（单目录 >= 5,000 文件）、普通 50 文件目录、深层目录（>= 20 层）、复杂用户组继承、过期授权、不同共享路径和高版本文件（>= 1,000 历史版本）。
PERF-DATA-03：对 DB 要求运行 ANALYZE，保留 schema/index 版本、PG 配置和 EXPLAIN (ANALYZE, BUFFERS) 摘要；不能用没有真索引的数据集“证明性能”。
PERF-DATA-04：生产数据不得被压测修改；必须在有明确隔离 DATABASE_URL/BLOB_DIR 的测试环境运行，禁向旧 Node data 和 8091 正式服务施压。

### 24.3 第一阶段交互 API 响应预算（参考环境，暖态，含真实鉴权）
下表为服务端请求总耗时（入口至最后一个 JSON 响应字节，上传/下载的长流另测），使用 30–100 个并发活跃虚拟用户、稳态 15 分钟、预热 5 分钟；每类采样 >= 1,000 个请求，单位 ms。
| 路径/用例 | p95 上限 | p99 上限 | 约束 |
|---|---:|---:|---|
| Session /api/me | 150 | 350 | session 查询/吊销检查不可省 |
| 文件夹当前页 50 行 | 300 | 800 | 包括授权、当前版本、基本元数据 |
| FolderTree 受权可见树 | 450 | 1200 | 优先按需节点加载，不要求一次返回 1 万节点 |
| effectivePermissions | 200 | 500 | 含祖先/组/限时与分享判定 |
| 文件详情/版本历史 50 行 | 300 | 800 | 明确稳定分页，含回滚来源 |
| 中文关键词检索 50 条 | 600 | 1500 | 50k 文本、命中高亮+权限过滤 |
| 我的关注/共享 50 行 | 300 | 800 | 包含状态和可见资源名称 |
| 回收站列表 50 行 | 350 | 900 | 不扫描全部删除子节点 |
| 普通用户范围统计 | 1000 | 2500 | 受授权范围与 10 万文件基准限制 |
| CSV 导出启动 | 800 | 2000 | 首字节到达，完整流另验收 |
| 模型预览任务创建 | 300 | 800 | 仅入队，不在请求内跑 OCCT |
| Office 编辑会话准备 | 600 | 1500 | 不含供应商 iframe 首次加载 |
| 有效锁申请/版本签入元数据 | 350 | 900 | 不含上传大文件流，不绕过事务 |
PERF-API-01：所有阈值包含真正的认证授权和数据库 IO；不得在压测中关闭审计、权限、版本校验以达到指标。
PERF-API-02：压力负载采用符合业务占比的混合权重，例如列表 35%、权限/目录 15%、搜索 15%、详情/版本 10%、共享/关注 10%、统计/导出 5%、写入/审批/锁 10%；需另测高写入与热点目录专项。
PERF-API-03：客户端 400/403/409 等业务预期错误单独统计，不计入 5xx；不可通过把 500 改成 200 伪造低错误率。
PERF-API-04：稳态 5xx 错误率目标 < 0.1%，服务不因普通用户的重试风暴 OOM；p99 是尾延迟目标，不得只给平均值。
PERF-API-05：持续 30 分钟的混合负载需有吞吐（RPS）、CPU、RSS、GC pause、PG connections、磁盘 IO、慢查询与错误码报告，不能只宣称 p95 达标。
PERF-API-06：突发负载 2× 稳态 5 分钟，允许限流 429/排队但必须维持数据正确性，避免 DB exhausted 和请求长时间 hang。
PERF-API-07：并发阶梯 1 / 10 / 30 / 100 / 200 虚拟用户，收集各级数据。200 用户作为上探容量测试，不自动代表所有 p95 必须仍达稳态门槛；需给出容量拐点。
PERF-API-08：cold-start、空缓存和权限变更后失效作为独立报告，不得全部隐藏于 warm-only 成绩。

### 24.4 浏览器、文件流、Office、CAD 专项预算
WEB-PERF-01：1440×900，Chrome 当前稳定版，中档开发办公电脑和测试 LAN 环境下，登录后首个文档目录的可交互时间 p95 目标 <= 2.5s（资源冷缓存与暖缓存分别报告）；不把静态空骨架显示当内容完成。
WEB-PERF-02：目录切换、排序、过滤响应用户输入应即时显示 loading/状态，实际列表刷新 p95 目标 <= 1s（服务端+网络+渲染）；不进行全量 DOM 100k 文件行渲染。
WEB-PERF-03：初始 React gzip/br 压缩后入口 bundle 应有大小预算和 bundle report；优先动态 import Office/CAD/统计重资源，在普通登录/文档列表页面不得加载 three.js 引擎。
WEB-PERF-04：Web 渲染不得有严重长任务/布局抖动；对 5,000 项目录做服务器分页后仍须有可用交互、键盘焦点和无空白表格错误。
IO-PERF-01：100MB 二进制上传必须流式、可取消，服务器内存峰值增长不按完整 body 成倍增长；记录 peak RSS 与 GC，进程不会因同时 10 个上传直接 OOM。
IO-PERF-02：MP4 Range 206/416、If-Range/ETag 按资源版本提供；在 100MB 视频样本里随机 seek 有效且首块 p95 目标 <= 600ms（在已授权、LAN、磁盘无拥塞条件下）。
IO-PERF-03：CSV 10万行导出采用流式扫描/输出、稳定快照/一致性语义、UTF-8 BOM 和公式注入防护；p95 首字节 <= 2s，完整传输耗时以实际网络吞吐报告，不给虚假固定总时长。
IO-PERF-04：传输取消及时关闭 DB cursor/文件句柄；不允许 goroutine/FD 持续泄漏，文件系统不足/连接重置响应清楚。
OFFICE-PERF-01：DOCX 引擎并发最少验证 5 / 10 / 20 编辑会话，10 MB 基准文档；测创建会话、iframe 加载、强制保存完成回调、端到端签入时间和编辑引擎资源，不用一个“平均耗时”概括。
OFFICE-PERF-02：保存/回调可能是多秒异步流程；用户操作应快速获得 taskId + 进度状态，最后由 commit 查询更新 UI。性能测量必须计入 Document Server 内部排队与回调。
OFFICE-PERF-03：编辑器崩溃与重启不能拖垮 Gin，已有当前版本可继续预览/下载，后台回调恢复和超时可诊断。
CAD-PERF-01：转换线程/进程独立限额，样本 STEP/IGES 10/50MB、复杂 100MB 网格模型分别记录排队时间、转换 p50/p95、峰值 RAM、输出三角数量、预览完整时间。
CAD-PERF-02：不要承诺所有 CAD 在 2 秒内转 GLB；同步 API 必须在创建任务后迅速返回 queued，并展示进度/转换排队提示。
CAD-PERF-03：普通工作日 CAD 转换 Worker 占满配额时，Gin 登录/目录/权限请求依然满足“降级测试阈值”——相较独立运行 p95 劣化不超过 25%；若同机资源隔离不足，判部署容量 Gate BLOCKED。
CAD-PERF-04：Worker 失败支持有限次数退避重试，不能无限重试同一畸形文件；失败记录稳定 errorCode，不阻塞该用户其他业务。

### 24.5 PostgreSQL、权限、索引与查询预算
DB-PERF-01：所有列表查询必须在结果集 LIMIT 之前完整施加授权与过滤规则；避免“先取前 200 后过滤掉无权限对象”造成假分页、泄漏 total 或不稳定结果。
DB-PERF-02：N+1 禁止：50 行文件页不应引发 >= 50 次按行查询 ACL/版本/上传人；可用 JOIN/CTE/批量预取。针对热路径统计 DB round-trips 和总 CPU。
DB-PERF-03：每个高频 SQL（文件列表、父子树、授权、搜索、共享、关注、审批、统计）必须保留 EXPLAIN ANALYZE,BUFFERS，以及基准规模下可接受的行扫描、排序与索引命中报告；大表顺序扫不是无条件违法，但必须解释成本。
DB-PERF-04：按 (folder_id,updated_at,id) 建稳定分页索引；pending 审批、权限到期、共享收件人、文件 current 关联使用有针对性的复合/部分索引，不能只在每列单独建索引。
DB-PERF-05：连接池有 maxConns/minConns/maxIdleTime/connectionLifetime/健康检查，基准记录 pool wait p95、连接占用、死锁、锁等待和查询取消；不能把 unlimited maxConns 当扩展方案。
DB-PERF-06：事务仅包元数据和记录写入，慢 IO/回调不占 PG 连接；写入业务事务 p95 需记录持续时间，热点文件在唯一性冲突时快速返回 409 而不是等整分钟。
DB-PERF-07：大量文件的 ACL 动态权限可使用访问范围 SQL/closure 或适当的受控权限快照，但授权撤销和限时到期仍必须实时生效，不靠过期的 Redis 缓存权限通过。
DB-PERF-08：中文全文检索索引不能过度同步阻塞上传；可用事务 outbox 异步索引，并提供 indexedSeq/indexStatus。索引尚未完成时，不可将“最新版本全文可搜索”作为已完成的事实。
DB-PERF-09：导出大型表使用只读事务/游标，隔离级别和一致性选择需登记；用户导出期间权限变化后的行为必须写清楚，避免长事务持锁阻塞在线修改。
DB-PERF-10：每个增量 migration 测数据回填规模、索引创建策略与停写窗口；涉及大表索引时评估 CONCURRENTLY 及其事务限制，不能在生产 100k/百万行表上盲目 ALTER TABLE 锁全站。

### 24.6 可观测性、压测工具和性能回归阻断
OBS-01：统一 OTel/结构化指标或等价组合，区分 http_server_request_duration、db_query_duration、
db_pool_wait、authorization_duration、blob_read/write_bytes、office_callback_lag、
cad_queue_depth、cad_job_duration、outbox_lag、gc_reclaimed_bytes。
OBS-02：指标按固定路由模板、业务动作和状态分类，禁止 fileId/userId/完整路径/搜索原文作为高基数 label；日志也不得泄露客户模型文件内容。
OBS-03：采集 Go pprof/trace 时走内网安全管理通道，生产默认公开端口不得暴露未授权诊断端点。
OBS-04：为数据库池耗尽、5xx 比例、磁盘空间<20%、outbox backlog、CAD 排队过长、Office callback 失败建立可配置告警与操作手册。
BENCH-01：使用 k6/vegeta 等负载工具（CLI 可执行和版本固定）、固定数据生成脚本及浏览器 Performance API/Playwright 测量，完整脚本纳入仓库，结果包含原始 JSON/CSV 和统计摘要。
BENCH-02：基准环境测前自动收集 commit SHA、二进制版本、container 配额、schema migration 版本、PG settings、dataset manifest、开始结束时间、用户 mix 和参数。
BENCH-03：每个性能测试要同时断言业务正确性，随机抽样 compare checksum、ACL、versionSeq、导出行数；只追速度不校验数据正确不算通过。
BENCH-04：每次影响 SQL/权限/文件流/Office/CAD Worker 的 PR 执行有关小样本基准，里程碑执行完整 100k 文件基准。
BENCH-05：相同数据/硬件下相较已批准基线，关键 API p95 回退 > 20% 或新 5xx/内存泄漏，CI/Release Gate 需失败并要求分析；外部硬件环境变化须重新建立可比较基线。
BENCH-06：不允许删除高成本用户/无权限测试、把基准集改成 100 行、关闭全文索引和审计、替换真实 Repo 为内存 mock 以获得合格数字。
BENCH-07：若容量不足或合法 DWG/Office 引擎尚未采购，按实际结果 BLOCKED，不把假转换页面判“高性能交付”。

### 24.7 性能验收 PE01–PE18
PE01 生成可重复 100k 文件/400k 版本/50k ACL/10k 文件夹数据集并核对校验和。
PE02 混合业务 30/100 并发 15 分钟，记录各路径 p50/p95/p99、RPS、CPU、RSS、错误率。
PE03 1/10/30/100/200 并发容量曲线，有退化拐点和不会丢数据的证据。
PE04 撤销 ACL 后列表/搜索/预览/统计/导出下一次请求立即失权，缓存不可泄漏。
PE05 大文件夹/深目录/工作组用户没有 N+1 权限 SQL 瀑布。
PE06 中文全文检索在 50k 可索引文件上 p95 符合表格且 total/snippet 正确。
PE07 10万行 CSV 流式导出且首字节、行数、BOM、公式字符合法，RSS 增长受控。
PE08 10 个并发 100MB 上传、断线取消、磁盘不足时 Gin 不 OOM、文件可恢复。
PE09 MP4 不同 Range 的 206、416、seek 与视频内容正确，p95 有报告。
PE10 Office 5/10/20 编辑会话与异步提交 callback 端到端测时、成功率、内存配额。
PE11 CAD 10/50MB STEP/IGES 与 100MB 网格测队列、worker peak RAM、转换成功率和渲染。
PE12 CAD worker 负载饱和时登录/目录/权限 p95 不超过独立基线的 1.25 倍。
PE13 DB pool max 连接压测，不发生无上限等待/超时漏事务。
PE14 数据库大表 EXPLAIN 与索引回归报告保存，高频请求没有无必要全表扫描/N+1。
PE15 打开/关闭 100 个模型或预览页面，前端 WebGL/内存/事件监听无明显单调泄漏。
PE16 浏览器 3 种桌面视口下真实目录首次可交互与切目录时延达预算。
PE17 注入 Office/CAD 依赖超时、数据库重启，API 能快速失败或降级且没有不一致数据。
PE18 每次性能测试输出机器可读报告，达标/失败对应发布阻断并记录基准环境。

---

## 25. 全局审查结果、文档优先级与发布总门禁（AUDIT-GATE）

### 25.1 全局审查记录与优先级
本次审查在 2026-10-08 将主 SPEC 从功能描述扩展为可检查的架构和性能契约；详见独立报告 SPEC-v2.1-ARCH-PERF-AUDIT.md。
该审查报告中所有 P0/P1/P2 条目均保留独立状态，状态只能是：
  OPEN / SPECIFIED_NOT_TESTED / IMPLEMENTED_NOT_VERIFIED / VERIFIED / WAIVED_BY_USER。
“已经写进 SPEC”最多是 SPECIFIED_NOT_TESTED，不能填 VERIFIED。
原 SPEC.md v2 是冻结的历史设计基线；它的“DDL 即契约/已定稿”不再代表新 Go/PostgreSQL 系统的实际可执行 schema。用户已经批准的 DEC-09..DEC-14 和本 v2.1 新合同优先。
若 §0–§22 任何条款与 §23 分层、§24 量化性能矛盾，以 §23/§24 为架构与性能执行权威；业务需求和安全防护不能因性能预算被减配。
本节 §25 为发布门禁的最终入口；§17 是扩展前阶段性审查结论，不得在 §17 停止阅读后续章节。
主 SPEC、审查报告、OpenAPI 文件、实际 SQL migrations、架构 lint 配置、真实基准压测脚本应具备一致的 issue/test ID，变更其中一个必须校验对应合同没有漂移。

### 25.2 总发布阻断矩阵
| Gate | 完成证据 | 尚未完成时禁止 |
|---|---|---|
| G-ARCH | AG01–AG16 实际执行、Go AST/import 检查、TS 边界 lint、依赖 ADR、真实构建 | 禁止宣称层次治理通过 |
| G-DATA | 所有 PostgreSQL 真实 migration、FK/UNIQUE/CHECK/事务/并发和 crash recovery 测试 | 禁止开展不可回退的数据迁移 |
| G-API | OpenAPI+Go/TS 类型、全端点授权矩阵、请求错误码、兼容策略、状态机测试 | 禁止以空接口和 Mock 数据宣布功能完成 |
| G-SEC | 跨部门越权、分享/回收站/审批/Raw/Office/CAD、恶意文件/CSV 安全用例 | 禁止开放生产文件读写 |
| G-PERF | §24 PE01–PE18 基准数据集、p95/p99、容量曲线、资源隔离、回归报告 | 禁止宣称高性能或上线达标 |
| G-BRAND | 正式 Logo 二进制 SHA 入库、VS01–VS18、截图回归 | 禁止称视觉风格已部署 |
| G-OFFICE | 合规 ONLYOFFICE 或同等引擎部署、DO01–DO14、回调安全、许可证资源 | 禁止称 DOCX 编辑已交付 |
| G-CAD | A 类真实样本 MC01–MC18、DWG 许可证/PoC、Worker 隔离及安全 | 禁止称常见机械格式全面在线预览 |
| G-LEGACY | DEC-15 新 PG/Blob/身份/初始化；旧 Node/SQLite/blob/证据隔离归档、路径不重叠 | 禁止复制/删改旧数据或未经批准切换 8091 |
| G-DEPLOY | 备份与实际恢复演练、审计/告警、可回退部署和 S1–S22 远程结果 | 禁止向用户宣布正式发布 |

### 25.3 两阶段实施权限
阶段 A — SPEC 完善与技术可行性研究：允许在隔离/可清理环境写概念验证、迁移 SQL 草案、OpenAPI、
架构 lint 和基准脚本；绝不编辑原 Node 行为参照或生产数据、不直接切换 8091。
阶段 B — 正式 Build：只有架构/API/DDL 合同冻结、必要许可证与 DEC-15 全新数据域/首装策略明确、
关键 PoC 可行、P0 决策关闭并由用户授权后才启动按 §15 的垂直切片任务。
若签约依赖无法合法落地（如 DWG SDK 或 Office 商用许可），本期功能完整交付状态必须标为 BLOCKED，
不许使用假预览/截图替代，也不能把未支持的 C 类格式错报为“完整支持”。

### 25.4 最终证据与报告格式
每个功能/接口/迁移/压测工作项至少提供：
  requirementId, ownerModule, implementingPackage, API/SQL reference, approvedMigrationVersion,
  testIds, testCommand, exactResult, environmentFingerprint, artifactHashes, performanceImpact, openRisks。
测试总览必须报告四组独立结论：
  BUSINESS（S1–S22 + PT/DO/MC）、ARCHITECTURE（AG01–AG16）、
  PERFORMANCE（PE01–PE18）、OPERATIONS（备份恢复/许可证/远程部署）。
不得输出一个模糊“所有测试通过”而不提供各组样本数、失败用例、环境和原始结果。
所有用户确认决策保留变更 ID 与日期；本次新增高性能和分层要求属于新的硬门禁，不得因发布时间紧缩跳过。
当前状态：DEC-15 已确定全新数据域；其它 SQL/API/依赖与真实性能 P0 尚未验证，**NO-GO for unconstrained Build/production deployment**。







