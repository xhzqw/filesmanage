# PRECISION-WORKBENCH-V2-SPEC — 重构级紧凑桌面精密工作台规范

> **项目**：filesmanage v2.1  
> **状态**：正式重构设计规范（Refactoring Master Plan）  
> **版本**：2.0.0-draft · 2026-10-09  
> **定位**：拔除卡通感/拟物感，构建比肩 Linear、JetBrains、macOS Finder 的极高密度、蓝白硬核工程桌面工作台。

---

## 1. 现状痛点审计与重构目标

### 1.1 核心病因审计台账（Current Layout Audit）

| 缺陷模块 | 当前现状测量值 | 造成的体验缺陷 | 重构目标测量值 |
|---|---|---|---|
| **整站视窗布局** | 顶栏 66px，外圈 `padding: 14px`，模块间 `gap: 14px` | 空间严重浪费，屏幕四边悬浮着一圈圈“积木孤岛”，像消费级 App | **顶栏 40px**，外圈 `padding: 0`，全站采用 **0-gap 1px 细线嵌合视窗（Docked Paneling）** |
| **主文件数据表** | `th, td` 内边距 `14px 16px`，行高高达 **52px** | 1080P 屏幕纵向只能看到 **8~10 行**，面对成千上万文件时滚动手酸 | **标准档 32px / 极限紧凑档 26px**，一屏纵向展示 **28~36 行**（信息密度提升 250%） |
| **容器倒角与边框** | 全量使用 `12px`、`18px`、`25px` 大气泡圆角 | 边界松垮、玩具感强烈，缺乏精密机械与工程软件严肃感 | 全面收敛为 **3px~4px 微圆角**，大浮层最高不超过 **6px**，使用 1px 硬朗分界线 |
| **空状态与动效** | 321×270px 巨型 3D 翻盖动画文件夹，大角度扇形扑克牌展开 | 视觉喧宾夺主，像儿童识字软件或营销页落地页插画，极度卡通 | 废黜巨型 3D 翻盖，重构为 **16px 极简工程线框小标 + 精致文字排版** |
| **目录树侧边栏** | 宽度 280px，`padding: 18px`，行高 36px，无层级引导虚线 | 横向挤占主表格，纵向展示目录极少，层级深时辨识度差 | 宽度 **240px**（支持 180~360px 拖拽），`padding: 0`，行高 **28px**，引入 **1px 树导轨虚线** |
| **颜色与视觉质感** | 浅蓝灰底、饱和度偏高的蓝色块、无层级的白框 | 呈现塑料感，缺乏高级感与深度 | 升级为 **冷感银白背景（#F8FAFC）+ 极细金属边框 + 激光极客亮蓝聚焦线（#02A0EA）** |

---

## 2. 精密设计系统 2.0 Token 规范

### 2.1 颜色系统（Color Hierarchy）

```css
:root {
  /* ================= 品牌核心色 (Brand Archetype) ================= */
  --brand-navy: #0F275C;            /* 权威深海蓝: 用于极重要标识、高对比主操作按键 */
  --brand-blue: #174098;            /* 工业工程蓝: 主交互、行选中、主要链接 */
  --brand-cyan: #02A0EA;            /* 激光极客亮蓝: 1px 聚焦线、选框激活、微交互光标 */
  --brand-cyan-muted: #E0F2FE;      /* 激光蓝微透底色: 悬停、轻度高亮 */

  /* ================= 表面与层级 (Surface & Elevation) ================= */
  --surface-canvas: #F8FAFC;        /* 工作台底衬冷白 (Slate 50) */
  --surface-panel: #FFFFFF;         /* 数据面板、表格纯白背景 */
  --surface-header: #F1F5F9;        /* 表头、工具栏淡冷灰底 (Slate 100) */
  --surface-row-hover: #F0F7FF;     /* 极轻微蓝行悬停底色 (不刺眼、不冒充选中) */
  --surface-row-selected: #E2EFFE;  /* 明确选中的蓝白高亮底 */
  --surface-active: #DBEAFE;        /* 按下/激活态底色 */

  /* ================= 结构线条与边界 (Hairline Borders) ================= */
  --border-hairline: #E2E8F0;       /* 1px 精细分界线 (Slate 200) */
  --border-subtle: #CBD5E1;         /* 控件未激活边框 (Slate 300) */
  --border-strong: #94A3B8;         /* 强对比边框 (Slate 400) */
  --border-focus: #02A0EA;          /* 激光焦点线 (1px solid + 1px inset) */
  --border-selected: #3B82F6;       /* 选中项外廓线 */

  /* ================= 文字与数据排印 (Typography Hierarchy) ================= */
  --text-primary: #0F172A;          /* Slate 900: 文件名、主要表单输入 (极致清晰) */
  --text-secondary: #475569;        /* Slate 600: 大小、版本、更新时间 (次要数据) */
  --text-tertiary: #94A3B8;         /* Slate 400: 哈希短码、表头标题、禁用文字 */
  --text-inverse: #FFFFFF;          /* 反白文字 */

  /* ================= 语义状态色 (Functional Indicators) ================= */
  --status-success: #15803D;        /* 正常/通过 */
  --status-warning: #B45309;        /* 待审核/锁定 */
  --status-danger: #B91C1C;         /* 冲突/删除/严重警告 */

  /* ================= 几何与紧凑度标尺 (Compact Metrics) ================= */
  --radius-xs: 2px;                 /* 紧凑标签、复选框 */
  --radius-sm: 4px;                 /* 按钮、输入框、行条 */
  --radius-md: 6px;                 /* 弹出菜单、轻量对话框 (最高限度) */
  
  --height-header: 40px;            /* 瘦身顶栏 */
  --height-toolbar: 34px;           /* 操作工具栏 */
  --height-table-header: 30px;      /* 表头高度 */
  --height-row-standard: 32px;      /* 标准紧凑数据行 */
  --height-row-ultra: 26px;         /* 极限紧凑数据行 (极客模式) */
  --height-tree-row: 28px;          /* 目录树节点行高 */
  --height-control: 28px;           /* 紧凑标准按钮/输入框高度 */
}
```

---

## 3. 视窗架构：一体化嵌合无缝工作台（Docked Paneling）

彻底取缔 `panels { padding: 14px; gap: 14px; }` 的悬浮气泡积木结构，转为全屏无缝咬合的 **Docked 3-Panel Architecture**：

```
+----------------------------------------------------------------------------------------------------+
| TOPBAR (40px) [Logo 22px] 示例科技 │ [Breadcrumb: 根目录 / 研发部 / 2026图纸] │ [⌘K 快速搜索] [用户] |
+------------------------+---------------------------------------------------------------------------+
| SIDEBAR (240px)        | TOOLBAR (34px) [上传文件] [新建目录] [移动] [删除] │ [排序] [密度: 紧凑/超紧凑]      |
| - 纯靠 1px 细线贴合     +---------------------------------------------------------------------------+
| - 28px 树节点行高      | DATAGRID (高度自适应, 内部虚拟滚动)                                          |
| - 1px 层级导轨虚线     |  [TH: 30px 吸顶表头] 文件名 │ 大小 │ 版本 │ 校验码(SHA) │ 修改时间 │ 操作       |
| - 支持左右拖拽调整列宽  |  [TR: 32px 紧凑数据行] ...                                                |
|                        |  [TR: 32px 紧凑数据行] ...                                                |
|                        +---------------------------------------------------------------------------+
|                        | STATUSBAR (24px 极细底栏) 已选 2 项 / 42.8 MB │ 共 1,280 个项目 │ 延迟 12ms   |
+------------------------+---------------------------------------------------------------------------+
```

### 3.1 核心区域布局参数定义

1. **顶栏（Top Navigation Bar）**：
   - 高度：`40px`，底边为 `1px solid var(--border-hairline)`。
   - 左侧：22px 矢量 Logo 标锁 + 紧凑系统名（13px 字号，加粗），宽度 240px 与侧边栏严格垂直对齐。
   - 中间：直接内嵌**可点击的面包屑路径（Breadcrumb）**，各级之间以极细 `›` 分割，溢出时中间自动折叠为 `…`。
   - 右侧：集成 `⌘K` 快捷搜索输入框（高度 `26px`，宽度 `200px`）与用户小头像徽标。
2. **侧边栏（Explorer Sidebar）**：
   - 宽度：默认 `240px`，最小 `180px`，最大 `360px`。
   - 外边距：`0`；内边距：`4px 0`。
   - 分割线：右侧设置 1px 细线；悬停时提供可拖拽把手（4px 热区，光标 `col-resize`）。
3. **主工作区（Work Area）**：
   - 工具栏与表格紧密相连，中间无缝，只留 1px 水平分割线。
   - 表头在滚动时强制吸顶（`position: sticky; top: 0; z-index: 2`）。
4. **状态底栏（Status Bar）**：
   - 高度 `24px`，字号 `11px`，浅灰背景。实时显示当前目录项数、选中项大小聚合、网络延迟与版本号。

---

## 4. 数据表格与列表重构规范（High-Density DataGrid）

### 4.1 列宽与对齐工程规范

| 列名 | 推荐宽度 | 对齐方式 | 排版规则 | 视觉呈现示例 |
|---|---|---|---|---|
| **选择框 (Select)** | 32px 固定 | 居中 | 14px 微型复选框，选中时为品牌亮蓝 | `[✓]` |
| **文件名 (Name)** | 自适应 (min 220px) | 左对齐 | 14px 细线类型图标 + 13px 文件名，单行省略并有 Tooltip | `[dwg] 装配体结构_v2.dwg` |
| **大小 (Size)** | 90px 固定 | 右对齐 | Tabular Nums 等宽数字，单位固定靠右 | `14.24 MB` |
| **版本 (Version)** | 60px 固定 | 居中 | 微型徽章标签（高度 18px，圆角 2px），底色 `#F1F5F9` | `v3` |
| **校验码 (SHA-256)**| 90px 固定 | 左对齐 | 前 8 位十六进制等宽代码字体（Consolas/Menlo） | `8f9a2b1c…` |
| **修改时间 (Updated)**| 130px 固定 | 右对齐 | Tabular Nums，格式 `YYYY-MM-DD HH:mm` | `2026-10-09 14:20` |
| **操作 (Actions)** | 80px 固定 | 居中 | 平时隐藏或极淡，行悬停时显露图标按钮 | `[↓] [···]` |

### 4.2 行交互状态机（Row Interaction States）

```
[ Default ]        -> 背景纯白 (#FFF) | 下边框 1px (#E2E8F0) | 文字 Slate 900
     ↓ (hover)
[ Hovered ]        -> 背景极淡蓝 (#F0F7FF) | 操作按钮显露 | 无位移动画
     ↓ (click)
[ Selected ]       -> 背景亮蓝浅底 (#E2EFFE) | 左边缘 2px 蓝光激光轨 (#02A0EA)
     ↓ (key navigation)
[ Focused+Selected]-> 背景浅蓝底 | 1px 内缩点状虚线或细外廓线 | 键盘 Space/Enter 可立即触发
```

---

## 5. 目录树重构规范（Compact FolderTree）

### 5.1 尺寸与引导轨标准
- **行高**：严格锁定为 **`28px`**。
- **层级缩进**：每一级子目录缩进 **`14px`**。
- **层级导轨（Guide Rails）**：使用 CSS 在深层节点左侧绘制 `1px solid #E2E8F0` 垂直虚线，一目了然看清层级归属，完全消除空隙错乱。
- **折叠小三角**：使用 10px 锐角小箭头（展开时下旋 90°，动画耗时 ≤120ms，线性利落）。

---

## 6. Rare-UI 灵魂重塑：硬核微交互重构

我们彻底摒弃儿童卡通般的 3D 翻盖大动画，将 Rare-UI 真正的“高光反光、弹簧物理、键盘跟手”提纯为以下 4 大工业级微交互组件：

### 6.1 `SpringActiveRail`（弹性激光高亮轨）
- **形态**：在侧边栏选中项或顶部 Tab 项左/下方的一条 **`2px` 高度/宽度的亮蓝线条**。
- **物理参数**：基于 `motion` 的 spring 物理：
  ```ts
  transition: { type: "spring", stiffness: 480, damping: 32 }
  ```
- **体验**：在上下键切换文件夹或切换文档视图时，蓝条像激光指针一样以毫秒级速度“弹射并丝滑停靠”在目标项，极具顶级工业软件质感。

### 6.2 `HairlineFocusBeam`（1px 激光边缘微光）
- **形态**：在搜索框、选中的数据行获得焦点时，边框不出现粗笨的 3px 光圈，而是呈现一道 **1px 的极细亮蓝光晕**：
  ```css
  box-shadow: 0 0 0 1px #02A0EA, 0 1px 2px rgba(2, 160, 234, 0.15);
  ```

### 6.3 `MicroHoldToDelete`（微型长按防误触按键）
- **应用场景**：回收站清空、删除敏感图纸、回滚历史版本。
- **形态**：尺寸仅 `26px` 高、`64px` 宽的小型硬朗按钮。按住时，按钮背景从左至右以深红/天蓝色平滑填充进度条（800ms），进度条内以等宽文字倒计时；松开瞬间回弹取消，填满瞬间触发操作，完全取代繁琐易怒的二次弹窗。

### 6.4 `CommandSpotlight`（`⌘K` 毫秒级全局指令台）
- **形态**：按下 `⌘K` / `Ctrl+K`，中心浮现 480px 宽的极客毛玻璃悬浮框（高度仅 36px 输入条 + 240px 紧凑结果流）。
- **效率**：直接输入拼音/文件名，立刻呈现最近修改与模糊匹配结果，方向键回车直接打开，工程人员无需在树状图层中翻找。

### 6.5 `FluidOrb` 环境柔光参数极度收敛
- 将登录页背景中 `FluidOrb` 的对比度与模糊度调整：
  - 模糊度由 16px 提升至 **`48px`**；
  - 不透明度由 0.65 压缩至 **`0.18`**；
  - 尺寸由 480px 调整为 **320px** 并偏居画面对角线角落。
  - **效果**：它不再是一个抢镜的玩具球，而是宛如精密仪器指示灯折射在冷白金属面板上的微弱科技环境光。

---

## 7. 源码级别重构方案（Blueprint & Diffs）

### 7.1 `web/src/theme.css` 全量重构核心规则

```css
/* ==========================================================================
   Precision Workbench 2.0 - Core Tokens & Reset
   ========================================================================== */

* { box-sizing: border-box; }

:root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px; /* 从 14px 收敛到标准的专业桌面 13px 字阶 */
  color: var(--text-primary);
  background: var(--surface-canvas);
  -webkit-font-smoothing: antialiased;
}

body { margin: 0; overflow: hidden; height: 100vh; }

/* 基础控件紧凑化 */
button, input, select {
  font: inherit;
  font-size: 12px;
  height: 28px;
  border-radius: var(--radius-sm);
}

button {
  cursor: pointer;
  border: 1px solid var(--border-hairline);
  background: var(--surface-panel);
  padding: 0 10px;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.1s ease;
}

button:hover {
  background: var(--surface-subtle);
  border-color: var(--border-subtle);
}

button.primary {
  background: var(--brand-blue);
  color: white;
  border-color: var(--brand-navy);
  font-weight: 500;
}

button.primary:hover {
  background: #11347d;
}

/* 一体化嵌合外壳 (彻底消除孤岛 gap) */
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-canvas);
}

.header {
  height: var(--height-header);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-hairline);
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}

.panels {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 0; /* 消除 14px 外边距 */
  gap: 0;     /* 消除 14px 模块间隙 */
}

/* 侧边栏贴边无边距 */
.sidebar {
  width: 240px;
  background: var(--surface-panel);
  border-right: 1px solid var(--border-hairline);
  border-radius: 0;
  padding: 6px 0;
  overflow-y: auto;
  overflow-x: hidden;
  flex: none;
}

/* 目录树 28px 紧凑节点 */
.tree-row {
  display: flex;
  align-items: center;
  height: var(--height-tree-row);
  padding: 0 8px;
  border-radius: var(--radius-xs);
  margin: 1px 4px;
  font-size: 12px;
}

.tree-row:hover { background: var(--surface-row-hover); }
.tree-row.on {
  background: var(--surface-row-selected);
  color: var(--brand-blue);
  font-weight: 600;
}

/* 主工作区与工具栏 */
.work {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-panel);
}

.toolbar {
  height: var(--height-toolbar);
  padding: 0 12px;
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-hairline);
  border-radius: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 极高密度数据表格 */
.table {
  flex: 1;
  background: var(--surface-panel);
  border: none;
  border-radius: 0;
  overflow: auto;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th, td {
  padding: 6px 10px; /* 从 14px 16px 彻底压缩 */
  border-bottom: 1px solid var(--border-hairline);
  text-align: left;
  font-size: 12px;
}

th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface-header);
  color: var(--text-secondary);
  font-weight: 600;
  height: var(--height-table-header);
}

tr {
  height: var(--height-row-standard);
  transition: background-color 0.05s ease;
}

tr:hover { background: var(--surface-row-hover); }
tr.selected { background: var(--surface-row-selected); }
tr.focused { outline: 1px dashed var(--brand-cyan); outline-offset: -1px; }

td.num, td.date, td.hash {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
```

---

## 8. 实施阶段与远端验证路线（Roadmap & Gate Checklist）

> 实施记录与逐条偏差说明：`PRECISION-WORKBENCH-V2-IMPLEMENTATION.md`（含对比度强制的颜色调整、操作列宽度、命中区下限等理由）。

### Phase 1：排版、Token 与外壳一体化（Foundation Refactor）
- [x] 重写 `web/src/theme.css`：下调基础字阶至 13px，定义精密蓝白 Tokens，行高全面锁定在 32px/28px。
- [x] 重构 `web/src/shared/ui/AppShell.tsx` 与 `web/src/app/AppShell.tsx`：顶栏瘦身至 40px，清除外层 `padding: 14px` 与 `gap: 14px`，侧栏紧凑靠左贴边。

### Phase 2：数据表与目录树高密度改造（Data Density Refactor）
- [x] 重构 `web/src/features/documents/FileTable.tsx`：
  - [x] 彻底废黜空状态的 3D 巨型翻盖文件夹，换为 16px 极简线框徽标；
  - [x] 表头吸顶，单元格 padding 压缩为 `6px 10px`；
  - [x] 数据列强制挂载等宽样式（`tabular-nums`）。
- [x] 重构 `web/src/features/folders/FolderTree.tsx`：
  - [x] 树节点行高锁定 28px，增加 1px 细线树导轨。

### Phase 3：Rare-UI 桌面硬核微交互升级（Delight Refactor）
- [x] 改造 `web/src/shared/ui/rare/`：
  - [x] 收敛 `FluidOrb` 粒子亮度与尺寸，作为克制冷感环境背景；
  - [x] 引入 `SpringActiveRail` 弹性定位线；
  - [x] 引入危险操作 `MicroHoldToDelete`。

### Phase 4：远端构建与多分辨率门禁回归（Remote Gates & Verification）
- [ ] 远端执行 `build.sh --with-tests`，保证 0 TypeScript 错误、0 架构漂移；
- [ ] 远端运行 `ux_visual_check.mjs`，全量刷新 1366×768、1440×900、1920×1080 截图；
- [ ] 确保端到端测试 `browser_business_check.mjs` 与全部 123 项通过矩阵依然 100% PASS。
