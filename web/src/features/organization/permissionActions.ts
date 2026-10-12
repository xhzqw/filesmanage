export const PERMISSION_ACTIONS=[
 ["list","查看列表"],["preview","预览"],["upload","上传/新建"],
 ["download","下载"],["modify","修改"],["delete","删除"],
 ["rename","重命名"],["move","移动"],["print","打印"],
] as const;
export const HIGH_RISK_PERMISSION_ACTIONS=new Set(["download","modify","delete","move"]);
