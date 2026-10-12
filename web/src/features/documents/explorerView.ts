export type ExplorerViewMode="icons"|"list"|"columns"|"gallery";
export const EXPLORER_VIEWS:{id:ExplorerViewMode;label:string}[]=[
 {id:"icons",label:"图标视图"},
 {id:"list",label:"列表视图"},
 {id:"columns",label:"分栏视图"},
 {id:"gallery",label:"画廊视图"}
];
const VIEW_KEY="filesmanage.explorer-view";
export function readExplorerViewMode():ExplorerViewMode{
 try{
  const value=localStorage.getItem(VIEW_KEY);
  if(EXPLORER_VIEWS.some(mode=>mode.id===value))return value as ExplorerViewMode;
 }catch{}
 return "list";
}
export function saveExplorerViewMode(mode:ExplorerViewMode){
 try{localStorage.setItem(VIEW_KEY,mode);}catch{}
}
