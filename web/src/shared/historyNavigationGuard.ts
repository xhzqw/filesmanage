type HistoryGuard=(event:PopStateEvent)=>void;
let activeGuard:HistoryGuard|undefined;

// 模块随 App 的静态依赖先于 BrowserRouter 初始化。popstate 的目标是
// window，必须先注册监听，才能在 Router 更新页面和清空草稿前阻止返回。
if(typeof window!=="undefined"){
 window.addEventListener("popstate",event=>activeGuard?.(event),true);
}

// 同一时刻只有前台编辑页拥有返回保护，卸载时按实例清理。
export function observeHistoryNavigationGuard(guard:HistoryGuard){
 activeGuard=guard;
 return()=>{if(activeGuard===guard)activeGuard=undefined;};
}
