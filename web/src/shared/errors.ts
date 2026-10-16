// Shared error-shape helpers. API failures carry a stable `code` field on the
// thrown Error; features map codes to user-facing copy.

import {ApiError} from "./http";

export function errorCode(error:unknown):string{
 if(error instanceof ApiError)return error.code;
 if(error instanceof Error&&"code" in error){
  const code=error.code;
  return typeof code==="string"?code:"";
 }
 return "";
}

export const ERROR_COPY:Record<string,string>={
 E_FORBIDDEN:"没有执行该操作的权限",
 E_NAME_CONFLICT:"名称已存在，请更换",
 E_VERSION_CONFLICT:"文件已被其他人修改，请刷新后重试",
 E_LOCKED:"文件被其他编辑锁定",
 E_APPROVAL_PENDING:"该目录的修改需要审批",
 E_CD_POLICY_AUTHORITY_PENDING:"质量体系正式审批缺少当前有效的受控制度依据，请先完成文控核验与发行",
 E_CD_DOCUMENT_CLASS_PENDING:"文件尚未经文控确认正式审批类别，请先完成文件归类",
 E_CD_QMS_APPOINTMENT_PENDING:"正式签批人缺少与当前节点匹配的有效岗位任命及独立文控核验",
 E_PARENT_MISSING:"原位置已不存在，请选择目标目录",
 E_NOT_FOUND:"资源不存在或已不可访问",
};

export function errorCopy(error:unknown,fallback:string):string{
 const code=errorCode(error);
 return ERROR_COPY[code]??fallback;
}
