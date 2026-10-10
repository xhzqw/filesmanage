package application

import(
 "archive/zip"
 "bytes"
 "fmt"
 "path/filepath"
 "sort"
 "strings"
)

const compareMaxOfficeArchiveBytes int64=8<<20
const compareMaxOfficeEntries=350

func looksOfficePackage(name string)bool{
 switch strings.ToLower(filepath.Ext(name)){
 case ".docx",".xlsx",".pptx",".odt",".ods",".odp":return true
 }
 return false
}

// OfficePartLines compares ZIP central-directory component checksums, WITHOUT
// decompressing untrusted document XML or interpreting active/embedded content.
// It provides structural rather than visual/semantic paragraph-level changes.
func OfficePartLines(data []byte)([]string,bool){
 z,err:=zip.NewReader(bytes.NewReader(data),int64(len(data)))
 if err!=nil||len(z.File)>compareMaxOfficeEntries{return nil,false}
 lines:=make([]string,0,len(z.File))
 for _,f:=range z.File{
  if f.FileInfo().IsDir(){continue}
  name:=strings.ReplaceAll(f.Name,"\\","/")
  lower:=strings.ToLower(name)
  // Office XML, binary resources, relationships and styles may affect layout.
  if strings.HasPrefix(lower,"_rels/")||strings.HasPrefix(lower,"docprops/")||lower=="mimetype"{continue}
  if !(strings.HasPrefix(lower,"word/")||strings.HasPrefix(lower,"xl/")||strings.HasPrefix(lower,"ppt/")||
     strings.HasPrefix(lower,"meta-inf/")||lower=="content.xml"||lower=="styles.xml"||lower=="meta.xml"||lower=="settings.xml"){continue}
  if strings.ContainsAny(name,"\n\r\t"){return nil,false}
  lines=append(lines,fmt.Sprintf("%s | %d B | CRC32 %08x",name,f.UncompressedSize64,f.CRC32))
 }
 if len(lines)==0{return nil,false}
 sort.Strings(lines)
 return lines,true
}
