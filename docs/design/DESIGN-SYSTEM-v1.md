# DESIGN-SYSTEM-v1 — Precision Workbench

> 项目：filesmanage v2.1 · 状态：**提案 / 待审定** · 版本：1.0.0-draft · 2026-10-09
>
> 本文是静态审计后的**设计实施合同**，不是已实现功能声明。以当前 `docs/SPEC-v2.1.md` §11、§23.5 和 `AGENTS.md` 为上位约束。正式 Logo 不存在时保持可信占位，不绘制伪 Logo。本地禁止构建/运行/测试；所有验证只在远端进行。

## 1. 目标、边界、原则

### 1.1 目标
- **低噪声**：白/浅蓝白面板、精确分割线、克制的品牌蓝；阴影只用于浮层，非全屏卡片化。
- **高信息密度**：44px 默认数据行、36px 紧凑行；列宽可配置，不隐去必需字段。
- **强状态反馈**：悬停、焦点、选中、提交中、冲突、失权、离线/失败必须视觉语义独立。
- **工程可靠性**：视觉表现服从授权、版本、锁和数据事实，不靠客户端猜测正式成功。
- **单一体系**：登录、文档、组织、分享、搜索、统计、审批、回收站、Office 外框、CAD 控件使用同一 Token 与基础原语。

### 1.2 不包含
- 重新实现 Go 权限、版本链、CAD 转换或 ONLYOFFICE 编辑器。
- 自行替换企业官方 Logo；未经授权部署 8091 或修改生产入口。
- 首期暗黑模式、跨目录复制、下载 ZIP、匿名外链和离线缓存。
- 将 CAD 模型材质、DXF 线色、DOCX 文本强制染成品牌蓝。

### 1.3 事实基线及偏差
| 源码/规范 | 当前证据（静态审计） | 本合同动作 |
|---|---|---|
| `web/src/theme.css:1-90` | 多模块 CSS 集中于单文件、色值大量硬编码 | 迁移 Token + 组件 CSS；禁止一次性无验证的全局替换 |
| `web/src/app/AppShell.tsx:34-56` | 部分页面使用共享 Shell | 保留并收敛唯一 Shell |
| `web/src/pages/Documents.tsx:64-85`、`Org.tsx:5-19`、`Preview.tsx:38-83` | 多页自行绘制 Header，存在分叉 | 逐页迁移到共享 Shell，无短时双导航 |
| `web/src/features/documents/FileTable.tsx:102-139` | 原生 table + 每行操作按钮 | 可访问数据表 + 状态工具栏；行为见桌面交互合同 |
| `web/src/features/folders/FolderTree.tsx:6-21` | JSX 递归 + `filter`、无树形键盘合同 | 树控件行为与按需数据接入 |
| `docs/SPEC-v2.1.md:883-939` | 已有品牌 Token v1 建议 | 保留兼容别名；将真实组件迁移到语义 Token |

## 2. Token 层级与变更治理

```
primitive（色、间距、字号原子）
  ↓
semantic（surface/text/border/action/focus/status）
  ↓
component（file-row/tree-item/dialog/toolbar/inspector）
  ↓
feature（审批状态、文件类型、CAD 辅助 UI：少量例外）
```

- `primitive` 仅由设计系统维护；业务组件只能使用 `semantic`/`component`，不得随意写自定义十六进制色。
- 兼容原 SPEC 的 `--brand-cyan`、`--brand-navy` 等关键名称；新增变量应提供逐步替换策略，不移除旧变量导致跨页退化。
- Design System 变更必须同步组件截图、键盘验收与对比度检测；禁止用只改检查器阈值代替合格实现。
- 公开 Token 清单需附主题版本号，视觉截图记录该版本；CSS 禁止影响用户原文内容和第三方 iframe。

### 2.1 参考语义 Token（待视觉签收）

```css
:root {
  --brand-cyan: #02A0EA;
  --brand-navy: #174098;
  --color-app-bg: #F6F8FB;     /* 新方向 A：候选，需与 SPEC #F4F9FE 做视觉评审 */
  --color-panel: #FFFFFF;
  --color-panel-subtle: #F7FBFF;
  --color-border: #DCE3EB;
  --color-border-strong: #B4CADB;
  --color-text: #1E293B;
  --color-text-secondary: #53677D;
  --color-action: #174098;
  --color-action-hover: #103679;
  --color-focus: #1473B8;
  --color-row-hover: #E8F5FD;
  --color-row-selected: #DFEFFB;
  --color-row-selected-border: #2386C9;
  --color-danger: #AA3145;
  --color-success: #17765D;
  --color-warning: #995E05;
  --color-folder: #E3AD3D;
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --height-control: 36px;
  --height-file-row: 44px;
  --height-file-row-compact: 36px;
  --height-tree-row: 36px;
  --radius-control: 8px;
  --radius-surface: 12px;
  --font-ui: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
}
```

颜色值是**建议候选**，具体对比度应在实际背景/文字组合下验证；`--color-app-bg` 与主 SPEC 初始方案存在候选差异，**签收后须同步更新主 SPEC 的 Token**，不得悄然漂移。

### 2.2 状态模型与组合态
| 状态 | 行为 | 视觉要求 |
|---|---|---|
| `default` | 可交互资源 | 主文字清晰、边界克制 |
| `hover` | 指针悬停 | 轻底色，不能冒充已选中 |
| `focused` | 键盘当前目标 | 清晰可感知的 focus ring / inset outline，不改变选择集 |
| `selected` | 业务选择集成员 | 稳定底色与边界，不能只依赖颜色 |
| `focused+selected` | 组合态 | 同时可识别焦点和选择 |
| `disabled` | 无可用动作 | 语义不可用、理由可查询，不以灰度独自说明 |
| `busy` | 事务提交中 | 阻止重复提交，展示作用对象与进度 |
| `warning/error/success` | 告知结果 | 文字与图标并用；警告不可自动消失至用户看不清 |
| `locked/pending` | 锁与审批状态 | 显示状态及可访问的详情/说明 |

- Focus ring 与选中边框需同时存在；适用 WCAG 2.2 AA：常规正文对比 ≥4.5:1，重要非文字交互边界/大字 ≥3:1，最终由自动检测 + 人工复核。
- 图标优先本地内联 SVG（统一 16/18/20/24px、约 1.75–2px stroke）。文件夹保持有限的黄色语义，不得用 emoji 或假 Logo 代替。
- `prefers-reduced-motion` 下关闭非必要动画，普通 hover/open 动画尽量 ≤200ms；CAD 功能动画不受该时长硬限制。

## 3. 信息架构与布局

### 3.1 统一 Shell
- Global Topbar 高 56px：真实品牌区、主要导航/全局搜索、当前身份、退出。
- Sidebar：默认 264px，可调 240–360px；导航/收藏/目录树可按业务分区；不得因导航收起遗失当前路径。
- Work Area：完整可操作面包屑、单一 Page Title、主工具栏、文件视图。
- Inspector：默认关闭（不遮挡主表）；开启后约 320px，可收起，读所选资源的权限、版本、锁和 CAD 元数据。
- Overlay 层：Popover/Menu/Dialog/Toast 顺序、焦点及滚动锁统一管理。
- 主列表的滚动容器与左树相互独立，长文件名以省略显示但提供可访问完整名称，时间/大小使用 tabular nums。

### 3.2 多视口
| 视口 | 约束 |
|---|---|
| 1920×1080 | 完整三栏可选，左树/表/Inspector 均有足够宽度 |
| 1440×900 | 默认左树+主表；Inspector 默认关闭/按需打开 |
| 1366×768 | 一级关键操作保持可见，次要项进“更多”；不能直接 `display:none` 消失 |
| 更窄 | 不承诺完整桌面三栏；提供可访问的抽屉式导航并保持移动/恢复功能 |

- 表格必要字段：文件名、大小、修改时间；视宽足够时显示版本、上传人、状态；SHA-256 放在 Inspector 或可展开详情，完整值可复制。字段显示优先级必须可配置而非无提示丢失。
- 默认表格行高 44px、紧凑 36px；树节点 36px；常用动作点击热区至少 32px，最低不能小于 WCAG 2.2 AA 适用要求。
- 路径采用真实可见祖先的面包屑，超过宽度时中间折叠；无权限祖先不泄露名称与路径。

## 4. 基础组件契约

### 4.1 组件目录建议
```
web/src/shared/ui/
  Button/ Input/ Textarea/ Select/ Combobox/
  Dialog/ AlertDialog/ Drawer/ Menu/ Tooltip/ Toast/
  Tree/ DataGrid/ Tabs/ Breadcrumb/ EmptyState/
  StatusIndicator/ Icon/ InspectorShell/
```
组件样式归组件自身；Feature 不得直接覆写 Modal 内部焦点或动画。可以选用成熟的无障碍原语实现，不能因“定制精度”而自行重写无障碍复杂内核且不测试。

### 4.2 关键组件
| 组件 | 必需 Props/行为 | 禁止行为 |
|---|---|---|
| `Dialog` | `open/onOpenChange/title/initialFocus/closeGuard`，真正模态、返回触发点 | `<dialog open>` 冒充真正 modal、无焦点恢复 |
| `AlertDialog` | 影响预览、二次确认、busy/防双击 | `window.confirm` 作为最终专业业务 UI |
| `Menu` | 鼠标右键 + 键盘 Shift+F10，受权动作、子菜单与 Esc | 未授权但仍可提交、菜单焦点逃逸 |
| `Tree` | ARIA tree 语义、展开状态、异步子节点、键盘漫游焦点 | 在 10k 目录下全量递归 mount，访问不可见祖先信息 |
| `DataGrid` | focus/selection 分离、排序、可访问列标题、键盘行导航 | 仅加 `role=grid` 却不实现键盘模式 |
| `Toast` | 成功/错误/长任务状态，操作结果引用稳定 ID | 业务写失败仍提示“全部完成” |
| `InspectorShell` | 根据稳定 resource ID 与最新权限加载 | 将敏感文件正文持久化到 Zustand/localStorage |
| `Combobox` | 可搜索，用户/组数据源明确，可键盘操作 | 用户/组共用错误的 ID 列表 |
| `FileTypeIcon` | 基于扩展名/格式元数据清楚区分 CAD、Office、纯文本等 | 把格式未知显示成精确已支持 |

### 4.3 页面级整合
| 页面 | 指定界面结构 | 不改变的业务事实 |
|---|---|---|
| 文档 | 左侧目录树 / 主文件表 / 可选 Inspector | 原文件/版本 ID、ACL、锁与审计逻辑 |
| 组织 | 部门树 + 工作组 + 成员列表/详情 | admin-only 管理 API |
| 预览/历史 | 文件概览 + 渲染器 + 版本时间轴 | append-only rollback 语义 |
| 审批 | 待我处理 / 我发起；状态 + 决定意见 Dialog | 202 pending 不变成已提交版本 |
| 回收站 | 列表 + 指定目标/同名冲突恢复 | 原资源 ID 与版本序列不重写 |
| 搜索/共享/关注 | 通用结果表与查询组件 | 授权 total/snippet 不泄露无权资源 |
| DOCX | 一致 Shell + 会话状态，原编辑器 iframe 不被主题覆盖 | ONLYOFFICE 回调/锁/审批 |
| CAD | 控件、装配树、元数据及格式状态清晰分区 | three.js 模型原始材质与未知单位诚实表述 |

## 5. 质量约束和验收

1. 新页面不得新增不受治理的品牌色/状态色；由静态规则 + 人工复核验证。SVG/CAD 材质与用户文件内容设明确白名单。
2. 完整记录 1366×768 / 1440×900 / 1920×1080 的截图及 route、角色、字体、Token 版本、焦点/选中态。
3. 禁止在任意页面截断必需的危险操作确认、权限说明和文件名可访问名称。
4. 从登录、文档、权限、共享、审批、版本、CAD 和 Office 全链路检查主题一致性；保留当前浏览器业务测试。
5. Token 对比度由远端实际浏览器自动测试并人工审查；不把设计候选数值宣传为实测通过。
6. Logo 已于 2026-10-09 按 SPEC §18 BRAND-03 可信入库（SHA-256 校验 + 可重放派生脚本与清单）；VS01–VS18 截图签收在远端验收时单独完成。

## 6. 变更先后顺序
1. Token 和底层 Button/Input/Menu/Dialog + Shell 统一。
2. 文件行、目录树、工具栏、Inspector 的可访问表现。
3. 权限、版本、上传、CAD/Office 外框等业务组件迁移。
4. 封锁新硬编码、回归截图和高密度布局。

> 设计合同与行为契约的条款冲突时，以 `DESKTOP-INTERACTION-v1.md` 明确的交互状态规则为准；安全授权与数据语义始终以主 SPEC 及后端服务为权威。
