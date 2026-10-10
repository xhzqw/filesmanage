# Rare UI 基础控件和反馈契约（2026-10）

## 设计系统归属

- 全局设计 Token：`web/src/theme.css`，状态背景使用 `--surface-*-soft`，圆角只能引用 `--radius-*`。
- 交互控件：`web/src/shared/ui/rare/RareControls.tsx` + `controls.css`，保留原生 button/input/select/textarea 语义、表单提交、tab 顺序和键盘行为。
- 状态反馈：`RareFeedback.tsx` + `feedback.css`。所有新的消息使用 `RareNotice`；内联状态标记使用 `RareBadge`。颜色只是辅助信息，必须保留可读状态文本。
- `Menu` 和 `Dialog` 仍分别管理非模态菜单和原生模态行为；不可在业务层重新实现焦点管理。

## API

```tsx
<RareButton tone="primary" loading={saving} type="submit">保存</RareButton>
<RareButton tone="danger" disabled={restricted} onClick={onRevoke}>撤销</RareButton>
<RareInput id="file-name" value={name} invalid={Boolean(error)} onChange={onChange}/>
<RareSelect value={scope} density="standard" onChange={onScopeChanged}>...</RareSelect>
<RareNotice tone="danger">当前操作失败，请重试。</RareNotice>
<RareBadge tone="warning" dot>待审核</RareBadge>
```

Button `tone`: primary / neutral / danger / ghost；`density`: compact（28px）/ standard（32px）。
`loading` 会同步设置原生 disabled、aria-busy 和 data-rare-loading，不能靠按钮文案的“提交中”替代状态。
Input / Select / Textarea 可设置 `invalid` 映射到 aria-invalid，同时保留原生 `size`、`type` 等属性。
Notice `tone`: info / success / warning / danger，danger 自动采用 `role=alert`，其余采用 `role=status`。
Badge `tone`: neutral / info / success / warning / danger，`dot` 只表示视觉点缀且从辅助技术树隐藏。

## 渐进迁移与验收

原页面 `.primary` / `.danger` 类目前仍是兼容层；**新代码不要根据 CSS 类名推断动作意图**，应传递显式 `tone`。
页面布局保留宽度、网格和容器间距归属；组件层接管内部状态、反馈色、聚焦边界和几何风格，避免 CSS 选择器覆盖业务布局。

每次修改必须在目标机运行 `bash scripts/build.sh --with-tests`，并运行不修改业务数据的 `node scripts/rare_ui_readonly_check.mjs`。
所有可能创建/永久删除验收文件的 UX 脚本，仅允许使用专用的 `*_test` 数据库和独立端口，不能在 18091 的共享业务数据上执行。


## 独立 UX 破坏性回归环境（仅目标机）

`scripts/ux_isolated_lab.sh setup` 创建或恢复 `filesmanage_ux_test`，从当前 migration 初始化空白测试数据，
独立口令写入远端 root-only 实验目录，并启动仅监听 `127.0.0.1:18092` 的 QA 实例；**不复用真实业务数据库、
Blob 存储或管理员密码，不丢弃任何数据库**。再次运行会检验保存的 PID 及 `/proc/<pid>/environ` 中的实际数据库、
监听地址和 Blob 路径，验证失败时不允许运行变更性测试。

命令（只能 SSH 进入目标机后执行）：

```bash
bash scripts/ux_isolated_lab.sh setup
bash scripts/ux_isolated_lab.sh status
bash scripts/ux_isolated_lab.sh run ux_desktop_check
bash scripts/ux_isolated_lab.sh run ux_visual_check
bash scripts/ux_isolated_lab.sh run ux_workflows_check
bash scripts/ux_isolated_lab.sh run ux_perf_check
bash scripts/ux_isolated_lab.sh run ui_geometry_check
bash scripts/ux_isolated_lab.sh stop
```

脚本 **不** 删除测试数据库与证据，方便失败后独立审查。若人工清理，请明确核对测试库名和目标目录；
任何将生产端口或共享数据混入此实验室的做法都应拒绝执行。
