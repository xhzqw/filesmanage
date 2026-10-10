import {request} from "../../shared/http";
import type {SearchPreset,SearchPresetFields} from "./searchPresets";

type ServerPreset={name:string;fields:SearchPresetFields;createdAt:string};
const decode=(items:ServerPreset[]):SearchPreset[]=>items.map(p=>({id:p.name,name:p.name,fields:p.fields,createdAt:Date.parse(p.createdAt)}));
export const searchPresetsApi={
 list:async()=>decode(await request<ServerPreset[]>("/search/presets")),
 save:async(name:string,fields:SearchPresetFields)=>decode(await request<ServerPreset[]>("/search/presets",{method:"POST",body:JSON.stringify({name,fields})})),
 remove:(name:string)=>request<{deleted:boolean}>("/search/presets/"+encodeURIComponent(name),{method:"DELETE"}),
};
