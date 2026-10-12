# Rare UI 组件接入与署名

本项目使用并改造了 [Rare UI](https://www.rareui.com/) 的动画 React 组件；其 [LICENSE](https://github.com/swamimalode07/rare-ui/blob/main/LICENSE) 包含 MIT、Commons Clause 及署名要求。Rare UI 是上游项目，不是本项目原创的组件库；衍生文件需保留来源说明和版权信息。

| 组件 | 来源与场景 | 改造说明 |
| --- | --- | --- |
| `GooeyNav` | 上游 [Gooey nav](https://www.rareui.com/components/gooeynav)；统计数量/容量切换 | React Router 替换 Next.js，CSS tokens 替换 Tailwind，蓝白品牌色、固定高度及 reduced-motion |
| `NotificationBell` | 参考上游 [Notification bell](https://www.rareui.com/components/notificationbell) 的交互规范；审批/生命周期通知 | 项目重写的轻量适配版，保留计数出现/消失、收到新消息摆动以及 reduced-motion，统一品牌色，不依赖 Radix |
| `RareButton`、`RareSelect`、`RareTabs`、`RareDataTable` | 本系统自建适配层，**不是上游组件** | 统一基础操作、输入、标签与数据表格；RareTabs 参考 Rare UI 的弹性指示方式增设不改变页面布局的 spring rail |
| `FolderResourceIcon`、`SpringActiveRail`、`FluidOrb`、`AnimatedCounter` | 自研的 Rare UI 风格实现；FolderResourceIcon 的开合微动效参考官方 [Folder component](https://www.rareui.com/components/foldercomponent) | 兼顾黄色文件夹识别、密集文件树、统计与低功耗；与官方放大式文件夹卡片不同 |

后续新组件必须区分“直接接入源码”“基于源码改造”和“参考风格自建”。高频表格/树行不得增加无意义动画；应保留键盘支持、焦点态、reduced-motion，颜色使用 `--brand-blue`、`--brand-cyan`、`--folder-fill` 与工程工作台 token。宽屏、笔记本、窄屏效果必须在远端验收。

## 第二批：公共交互控件（自建，非 Rare UI 官方源码）

- **Dialog**：新增统一紧凑标题栏及关闭图标，调用现有 `closeGuard` 防止提交中误关；首焦点仍进入表单字段，原有原生 `showModal()`、Escape、焦点恢复逻辑不变。
- **Menu**：使用 React Portal 避免受文件表格、目录树滚动容器裁切；保持键盘方向键/Home/End/Escape、光标定位、锚点焦点恢复及缩减动效。
- **RareSelect**：统一品牌样式并补齐 combobox ARIA、搜索高亮、跳过禁用项、活动选项自动滚动、禁止失效下拉继续打开；继续在原生 `select` 处理表单值。
- **Toast**：隐藏标签页期间暂停自动关闭计时，回到页面仍有反馈；保留模态框顶层提示与优先级/并发操作语义。

这些控件是按照 Rare UI 的交互理念和系统现有设计 token 自研实现，不宣称来自官方同名组件。

## 第三批：业务界面真实使用，而非只提供封装

- 组织权限的三个一级视图由普通文字按钮改为**实际渲染上游改造的 GooeyNav**。蓝色选中项从浅灰背景中分离并使用 spring 过渡；原有 URL 参数、未保存变更拦截和审计深链接保持不变。
- 权限详情的“授权列表 / 生效权限”改用 **RareTabs**，保持 WAI-ARIA 的选中和方向键行为；新建授权是单独操作按钮而非冒充 Tab。
- 组织管理的主要 Tab 采用蓝底白字的清晰选中态，保留弹性底部导轨、徽标计数和原始 tabpanel ID，不改变页面尺寸。
- 文件列表开始 **实际渲染 RareDataTable**，保留原生 `role=grid` 的多选/快捷键/拖动语义，选中行使用品牌蓝导轨。
- 文件工具栏移除常驻的四个禁用批量按钮，只在选中文件后显示带数量、操作和撤销选择的紧凑批量工具条；未选中时保留上传、建目录、排序、筛选和搜索的主要入口。

以上界面由品牌 token 控制，不引入官网示例配色；保持较低动画频次，兼容 `prefers-reduced-motion`。
