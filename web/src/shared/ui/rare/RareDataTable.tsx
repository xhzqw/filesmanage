import {type HTMLAttributes,type TableHTMLAttributes} from "react";
import "./dataTable.css";

/** Shared semantic data table. Feature-owned column widths and keyboard/selection
 * semantics remain untouched (file grid uses a separate ARIA grid contract). */
export function RareDataTable({className="",density="compact",...props}:TableHTMLAttributes<HTMLTableElement>&{
 density?:"compact"|"standard";
}){
 return <table {...props} data-rare-table="" data-rare-density={density}
  className={"rare-data-table"+(className?" "+className:"")}/>;
}

/** Put inside <td>; never apply flex/display to the table-cell itself. */
export function RareRowActions({className="",...props}:HTMLAttributes<HTMLDivElement>){
 return <div {...props} className={"rare-row-actions"+(className?" "+className:"")}/>;
}
