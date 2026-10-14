# 第三方软件与素材声明

本文件记录已识别、与开源发行尤其相关的第三方项目。**不是完整的软件物料清单（SBOM），也不是任何第三方代码的重新许可。** 发布前仍须逐项核对依赖、复制的源码及资源。

## ONLYOFFICE Docs Community Edition

- 项目：https://github.com/ONLYOFFICE/DocumentServer
- 用途：以独立 Document Server 服务实现 DOCX 在线编辑、协作与回调保存；本项目通过 API 集成。
- 上游许可证：GNU AGPLv3 **连同上游 LICENSE 中的附加条款**，见 https://github.com/ONLYOFFICE/DocumentServer/blob/master/LICENSE 。
- 义务：保留上游版权、许可证、界面中适用的法律声明与署名；修改了其源码时标记修改；按适用条款提供相应源码。上游许可证**不授予 ONLYOFFICE 商标使用权**。
- 本仓库的第一方 AGPLv3 许可证不得被理解为对 Document Server 源码、标识或附加条件的替代。

## Rare UI

- 项目：https://github.com/swamimalode07/rare-ui
- 用途：页面交互及视觉组件的源代码改造；具体涉及范围必须在发布前进行文件级核对。
- 上游许可：MIT + Commons Clause + 署名要求，详见 https://github.com/swamimalode07/rare-ui/blob/main/LICENSE 。
- 署名：[Rare UI](https://www.rareui.com/)；保留复制源码所需的版权声明与原始归属。
- **公开发布阻断项**：该组件许可带有限制性附加条件，不能直接宣称复制的组件代码已按 AGPLv3 重新授权。需先确认公开仓库分发形式满足上游条款；无法确认时，应更换为许可兼容的自主实现或取得权利方额外授权。

## 品牌资产、图标、字体与业务资料

`web/public/assets/brand/` 等路径含有特定企业的 Logo、设备/场景图片及衍生图。源代码授权**不自动涵盖这些资产的商标权、肖像权、版权和商业使用权**。第三方图标、字体、CAD 示例、签名/公章样本同样须另行审查并明确归属；无法确认授权的资源应移出公开包并替换为开源或自行制作的通用资源。
