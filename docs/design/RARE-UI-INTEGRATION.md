# Rare UI 组件接入与署名

本项目使用并改造了 [Rare UI](https://www.rareui.com/) 的动画 React 组件；其 [LICENSE](https://github.com/swamimalode07/rare-ui/blob/main/LICENSE) 包含 MIT、Commons Clause 及署名要求。Rare UI 是上游项目，不是本项目原创的组件库；衍生文件需保留来源说明和版权信息。

| 组件 | 来源与场景 | 改造说明 |
| --- | --- | --- |
| `GooeyNav` | 上游 [Gooey nav](https://www.rareui.com/components/gooeynav)；统计数量/容量切换 | React Router 替换 Next.js，CSS tokens 替换 Tailwind，蓝白品牌色、固定高度及 reduced-motion |
| `NotificationBell` | 参考上游 [Notification bell](https://www.rareui.com/components/notificationbell) 的交互规范；审批/生命周期通知 | 项目重写的轻量适配版，保留计数出现/消失、收到新消息摆动以及 reduced-motion，统一品牌色，不依赖 Radix |
| `RareButton`、`RareSelect`、`RareTabs`、`RareDataTable` | 本系统自建适配层，**不是上游组件** | 统一基础操作、输入、标签与数据表格；RareTabs 参考 Rare UI 的弹性指示方式增设不改变页面布局的 spring rail |
| `FolderResourceIcon`、`SpringActiveRail`、`FluidOrb`、`AnimatedCounter` | 自研的 Rare UI 风格实现；FolderResourceIcon 的开合微动效参考官方 [Folder component](https://www.rareui.com/components/foldercomponent) | 兼顾黄色文件夹识别、密集文件树、统计与低功耗；与官方放大式文件夹卡片不同 |

后续新组件必须区分“直接接入源码”“基于源码改造”和“参考风格自建”。高频表格/树行不得增加无意义动画；应保留键盘支持、焦点态、reduced-motion，颜色使用 `--brand-blue`、`--brand-cyan`、`--folder-fill` 与工程工作台 token。宽屏、笔记本、窄屏效果必须在远端验收。
