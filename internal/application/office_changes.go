package application

import (
 "strings"
)

// SemanticChange represents an Office value at a stable extracted location.
// For DOCX the location is a paragraph ordinal, not an authoring-tracked ID.
// For XLSX the location is a worksheet part and cell coordinate.
type SemanticChange struct {
 Kind string `json:"kind"`
 Section string `json:"section"`
 Key string `json:"key"`
 Before string `json:"before"`
 After string `json:"after"`
}

type semanticValue struct{
 section string
 key string
 value string
}

func parseSemanticLine(line string,kind string)(semanticValue,bool){
 if kind==".docx"{
  key,value,ok:=strings.Cut(line," ")
  if !ok||!strings.HasPrefix(key,"¶")||len(key)>10{return semanticValue{},false}
  return semanticValue{section:"正文",key:key,value:value},true
 }
 if kind==".xlsx"{
  sheet,cellLine,ok:=strings.Cut(line," ")
  if !ok||!strings.HasPrefix(sheet,"sheet")||!strings.HasSuffix(sheet,".xml"){return semanticValue{},false}
  cell,value,ok:=strings.Cut(cellLine,"  ")
  if !ok||len(cell)>16||len(cell)==0||!validCellCoordinate(cell){return semanticValue{},false}
  return semanticValue{section:strings.TrimSuffix(sheet,".xml"),key:cell,value:value},true
 }
 return semanticValue{},false
}

func validCellCoordinate(value string)bool{
 seenNumber:=false
 for _,c:=range value{
  if c>='0'&&c<='9'{seenNumber=true;continue}
  if c<'A'||c>'Z'||seenNumber{return false}
 }
 return seenNumber
}

func OfficeSemanticChanges(before,after []string,kind string)([]SemanticChange,bool){
 if len(before)>compareMaxLines||len(after)>compareMaxLines{return nil,false}
 left:=map[string]semanticValue{}
 right:=map[string]semanticValue{}
 order:=[]string{}
 for _,line:=range before{
  v,ok:=parseSemanticLine(line,kind);if !ok{return nil,false}
  id:=v.section+"\x00"+v.key
  if _,exists:=left[id];exists{return nil,false}
  left[id]=v;order=append(order,id)
 }
 for _,line:=range after{
  v,ok:=parseSemanticLine(line,kind);if !ok{return nil,false}
  id:=v.section+"\x00"+v.key
  if _,exists:=right[id];exists{return nil,false}
  right[id]=v
  if _,exists:=left[id];!exists{order=append(order,id)}
 }
 result:=make([]SemanticChange,0)
 for _,id:=range order{
  l,had:=left[id];r,has:=right[id]
  if had&&has&&l.value==r.value{continue}
  current:=l;if !had{current=r}
  item:=SemanticChange{Section:current.section,Key:current.key}
  if had{item.Before=l.value}
  if has{item.After=r.value}
  switch{case !had:item.Kind="added";case !has:item.Kind="removed";default:item.Kind="changed"}
  result=append(result,item)
 }
 return result,true
}
