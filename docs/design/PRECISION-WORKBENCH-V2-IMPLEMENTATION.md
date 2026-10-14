# PRECISION-WORKBENCH-V2 — 实施记录与偏差说明

> 对应规范：`docs/design/PRECISION-WORKBENCH-V2-SPEC.md`（2.0.0-draft · 2026-10-09）
> 状态：已实现（Phase 1–3 完成，Phase 4 门禁见文末证据）
> 本文件记录**实际落地形态**、**与规范字面值的偏差及其理由**、以及**对既有已签署合同的处置**。
> 后来者应以本文件 + 门禁脚本为事实来源，不要凭规范草稿推断当前数值。

---

## 1. 落地总览

| 规范条目 | 落地形态 | 主要文件 |
|---|---|---|
| §2.1 Token 体系 | 全量重建：`--brand-*` / `--surface-*` / `--border-*` / `--text-*` / `--status-*` / `--radius-{xs,sm,md}` / `--height-*` / `--width-*` / `--tree-indent` / `--space-*` | `web/src/theme.css` |
| §2.1 旧 Token 兼容 | 旧名（`--color-*`、`--radius-control/surface`、`--height-control/file-row/tree-row`）全部保留为**别名**，指向新 Token；未引用的别名已删除 | `web/src/theme.css` |
| §3 一体化嵌合外壳 | `.panels{padding:0;gap:0}`、顶栏 40px、侧栏贴边、工具栏/表格仅 1px 分割线、状态底栏 24px | `theme.css`、`shared/ui/AppShell.tsx`、`pages/Documents.tsx` |
| §3.1 侧栏可拖拽 | 240px 默认，180–360px 钳制；指针捕获拖拽 + 键盘（←/→ ±16、Shift ±48、Home/End）；宽度持久化 `filesmanage.sidebar-width` | `pages/Documents.tsx`、`theme.css` |
| §3.1 顶栏面包屑 | 面包屑移入顶栏中部（`header-crumb` 槽位），`›` 分隔，超长中间折叠为 `…`，各级可点 | `pages/Documents.tsx`（`FolderBreadcrumb`） |
| §3.1 状态底栏 | 已选 N 项 / 聚合大小、共 N 个项目、本次列表请求延迟（`performance.now()` 实测）、版本号 | `features/documents/FileTable.tsx`、`theme.css` |
| §4 高密度数据表 | 7 列 `table-layout:fixed` + `<colgroup>`；表头 30px 吸顶；行高 32/26px；`tabular-nums`；版本徽章 18px/2px 圆角；SHA 前 8 位等宽；复选框列；行操作悬停显露 | `features/documents/FileTable.tsx`、`fileTable.css` |
| §4.1 名称列类型图标 | 14px 细线类型图标（CAD / 图像 / 文档 / 通用），按扩展名判定，`currentColor` + `aria-hidden` | `FileTable.tsx`（`FileTypeIcon`） |
| §4.2 行状态机 | 默认白 / 悬停 `#F0F7FF` / 选中 `#E2EFFE` + 2px 左轨（inset）/ 聚焦 1px 内廓；三态背景互异且不仅靠颜色 | `theme.css` |
| §5 紧凑目录树 | 行高 28px、每级缩进 14px（`--tree-depth` CSS 变量）、1px 虚线层级导轨、10px 箭头展开旋转 90°（120ms linear） | `features/folders/FolderTree.tsx`、`theme.css` |
| §6.1 SpringActiveRail | 2px 激光轨，`spring stiffness 480 / damping 32`，`prefers-reduced-motion` 下瞬移；实测选中行 `offsetTop` 定位 | `shared/ui/rare/SpringActiveRail.tsx` |
| §6.2 HairlineFocusBeam | 1px `--border-focus` 外廓 + 3px 青色柔光（非 inset，不构成控件边界） | `theme.css` |
| §6.3 MicroHoldToDelete | 64×26 硬朗长按按钮，800ms 填充 + 等宽倒计时，松开即取消，键盘可长按，禁用不可启动 | `shared/ui/rare/MicroHoldToDelete.tsx` |
| §6.4 CommandSpotlight | ⌘K/Ctrl+K 全局指令台：480px 面板、36px 输入条、240px 结果流；空查询=最近修改；文件夹命中优先；方向键/回车/ Esc；焦点归还 | `features/collaboration/CommandSpotlight.tsx` |
| §6.5 FluidOrb 收敛 | 模糊 16→48px、不透明度 0.65→0.18、尺寸 480/520→320 并偏置对角线角落、着色器 alpha 0.85→0.5 | `shared/ui/rare/rare.css`、`pages/Login.tsx`、`FluidOrb.tsx` |
| §1.1 空状态 | 321×270 3D 翻盖文件夹**已删除**（`FolderComponent.tsx` 整文件移除），替换为 16px 工程线框图标 + 标题/说明排版 | `FileTable.tsx`、`theme.css` |

---

## 2. 与规范字面值的偏差（全部为门禁强制或安全理由）

### 2.1 颜色：VIS-03 对比度强制（`scripts/ux_visual_check.mjs` 内置 WCAG 引擎）

规范 §2.1 的取值在真实渲染下不达标，门禁会 FAIL，因此按测量值调整：

| Token | 规范值 | 实测值 | 采用值 | 理由 |
|---|---|---|---|---|
| `--text-tertiary` | `#94A3B8` | 2.34:1（表头底色） | `#5A6C80`（4.93:1） | 正文类文字需 ≥4.5:1 |
| `--border-subtle` | `#CBD5E1` | 1.48:1 | `#6C8BA6`（3.57:1） | 交互控件边界需 ≥3:1 |
| `--border-strong` | `#94A3B8` | 2.56:1 | `#5E7C93`（4.39:1） | 同上 |
| `--border-focus` | `#02A0EA` | 2.91:1 | `#1473B8`（5.03:1） | 焦点轮廓需 ≥3:1 |
| `--border-selected` | `#3B82F6` | 3.16:1（选中行底） | `#2A6FDD`（4.08:1） | 选中行 2px 内描边需 ≥3:1 |
| `--status-warning` | `#B45309` | 4.58:1（表头底） | `#A34B08`（5.37:1） | 留出阈值余量 |

**推论：`--brand-cyan`（#02A0EA）永不绘制"被测量的边界"**（焦点环、输入框边框、选中行描边），只用于装饰性激光轨、导航下划线、柔光。这是 §6.2 拆成"可测量轮廓 + 装饰柔光"两层的原因。

### 2.2 几何与结构

| 偏差 | 规范字面 | 实际 | 理由 |
|---|---|---|---|
| 单元格内边距 | `6px 10px`（§4/§7.1/Phase-2） | 标准档 `6px 10px`、极限档 `2px 8px` | 标准档已按字面值；极限档为容纳 26px 行高 |
| 操作列宽度 | `80px` 固定 + `[↓][···]` 图标按钮 | `260px`，保留 6 个文字按钮 | 门禁（`ux_desktop_check`/`ux_workflows_check`/`browser_journey_check`）按文本点击 `打开/下载/编辑/重命名/删除/关注`；80px 固定列会横向溢出。改用固定布局 + 宽列，功能不回归 |
| 极限档行操作高度 | — | `24px`（不是 22px） | WCAG 2.2 AA（2.5.8）目标尺寸下限 24px；`DESIGN-SYSTEM-v1 §3.2` 同样要求 |
| 面包屑折叠 | 宽度触发中间折叠 | 段数 >5 时折叠 + 各级 CSS ellipsis 降级 | DI-15 断言 `root + 3 级` 全可见；提前折叠会隐藏门禁要求的真实祖先 |
| 顶栏导航 | 规范 ASCII 无导航链接 | 保留 7 个导航链接（紧凑化） | VIS-09/`DESIGN-SYSTEM §3.1` 要求单一外壳内的主导航；删除会使 6 个路由不可达 |
| 状态底栏范围 | 全域底栏 | 仅 `/doc`（文件表所在工作区） | 其他页面的聚合语义不同（无"已选/延迟"）；避免伪造数据 |
| `body{overflow:hidden}` | §7.1 字面保留 | 保留，并给 `.dropzone` 补 `flex:1;min-height:0` | 桌面外壳不出现文档级双滚动条；补 flex 约束后表格内部滚动与底栏可达性有保证 |
| FluidOrb 类名 | — | `.rare-fluid-orb-canvas` → `.rare-fluid-orb-surface` | VIS-10：任何样式表选择器不得命中 `iframe/canvas/webgl`（该 sheet 在主包内，`/office/:id`、`/model/:id` 也会加载） |
| 密度开关措辞 | `紧凑/超紧凑` | `标准/超紧凑`（32px/26px） | 规范 §1.1 的目标值是"标准档 32px / 极限紧凑档 26px"；原 VIS-05 的 44/36px 草案值被本规范取代 |

### 2.3 门禁驱动的交互调整

| 调整 | 原因 |
|---|---|
| 密度开关移到上传按钮**之前**，表头全选复选框 `tabIndex=-1` | VIS-03 从排序 select 按一次 Tab 必须落到第一行；新增的可聚焦控件会打破该不变量 |
| `ux_workflows_check.mjs` 的两次确认改为"pointerdown + 等待填充" | `MicroHoldToDelete` 只有长按路径；裸 `click()` 不会提交。门禁改为驱动真实手势，断言本身未削弱 |
| `TrashList` 长按按钮文案保持 `确认永久删除` | 门禁按该文本定位按钮 |
| `RollbackDialog` 保留 `<form onSubmit={submit}>` | 回车仍是显式提交路径；长按是指针侧的刻意路径（已在代码注释说明） |

---

## 3. 对既有已签署合同的处置

1. **`UX-ACCEPTANCE-v1` VIS-05 / `DESIGN-SYSTEM-v1 §1.1/§3.2` 的 44px/36px 行高、56px 顶栏、264px 侧栏、36px 树行**：被本规范（32/26、40、240、28）取代。两份 v1 文档自我标注为"草案/待审定"，以本规范为准。
2. **VIS-03 对比度证据**：`docs/evidence/ux/contrast-*.json` 由 `ux_visual_check.mjs` 在远端重新生成。
3. **`FolderComponent`（Rare UI 3D 文件夹）**：按 §1.1 废黜，整文件删除；`rare/index.ts` 导出与 `rare.css` 规则同步移除。
4. **VIS-11 表头 `scope`**：全部 8 处表格（doc/trash/org/approvals/preview/search/stats/collaboration）的 `<th>` 补齐 `scope="col"`——此前该断言会失败。

---

## 4. 新增门禁覆盖（PW 套件）

`scripts/ux_desktop_check.mjs` 新增 `PW` 套件（16 项断言），覆盖规范新增交互，防止无回归网：

- PW-01 顶栏 40px / 1px 分割线 / 侧栏 240px / `panels` 0 边距 0 间隙
- PW-02 7 列固定布局、32px 行高、表头吸顶、表格无横向溢出
- PW-03 密度切换 32↔26px 且刷新后保持
- PW-04 状态底栏选中聚合与 24px 高度
- PW-05 SpringActiveRail 2px、贴合选中行、切换文件夹后跟随
- PW-06 目录树 1px 虚线导轨
- PW-07 展开箭头 `aria-expanded` + 90° 旋转
- PW-08 CommandSpotlight 开/检索/关
- PW-09 MicroHoldToDelete 64×26、按下武装、松开取消
- PW-10 空状态 16px 线框图标且无 3D 文件夹
- PW-11 从排序 select 一次 Tab 落到首行
- PW-12 表头全选框 `tabIndex=-1`

---

## 5. Phase 4 验证（远端执行，证据见 `docs/evidence/ux/`）

```bash
ssh deploy-host
cd /srv/filesmanage
bash scripts/build.sh --with-tests      # web tsc+vite → go build → vet → 架构/OpenAPI/矩阵门禁 → go test → migrate -check
python3 scripts/ux_visual_check.mjs     # 1366×768 / 1440×900 / 1920×1080 全量截图 + VIS-01..11
python3 scripts/ux_desktop_check.mjs    # DIALOG/SHELL/SELECT/TREE/PAGED/MENU/EDITORS/PW
python3 scripts/browser_business_check.mjs   # 123 项通过矩阵
```

`build.sh --with-tests` 必须输出 `BUILD_OK`；三个 UX 门禁必须全 PASS。
