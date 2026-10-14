import {compactExplorerName} from "./explorerDisplayName";

// Share the same middle-truncated CJK display and quiet extension treatment
// between grid tiles, current columns and ancestor Finder columns.
export function ExplorerCompactName({name}:{name:string}){
 const compact=compactExplorerName(name);
 const match=compact.match(/^(.*)(\.[a-zA-Z0-9]{1,8})$/u);
 return <>{match?<><span className="explorer-name-stem">{match[1]}</span><span className="explorer-name-extension">{match[2]}</span></>:<span className="explorer-name-stem">{compact}</span>}</>;
}
