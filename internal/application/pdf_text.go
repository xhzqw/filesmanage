package application
import("bytes";"strings";"rsc.io/pdf")
// PDF text layer only, with bounded input/pages/output. Invalid or encrypted
// files fail to filename-only indexing; OCR is deliberately out of scope.
const maxPDFIndexSource=8<<20
const maxPDFIndexPages=50
func pdfTextLayer(data []byte)(result string){
 if len(data)<8||len(data)>maxPDFIndexSource||!bytes.HasPrefix(data,[]byte("%PDF-")){return ""}
 defer func(){if recover()!=nil{result=""}}()
 reader,err:=pdf.NewReader(bytes.NewReader(data),int64(len(data)))
 if err!=nil||reader.NumPage()<1||reader.NumPage()>maxPDFIndexPages{return ""}
 var text strings.Builder
 for page:=1;page<=reader.NumPage();page++{
  fragments:=reader.Page(page).Content().Text
  if len(fragments)>indexTextLimit{return ""}
  lastY,lastX:=0.0,0.0
  for i,f:=range fragments{
   if f.S==""{continue}
   if i>0&&(f.Y!=lastY||f.X-lastX>20){text.WriteByte(' ')}
   if text.Len()+len(f.S)>indexTextLimit{return text.String()}
   text.WriteString(f.S);lastX=f.X+f.W;lastY=f.Y
  }
  text.WriteByte('\n')
 }
 return text.String()
}
