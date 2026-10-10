package application
import "context"
// ReindexPDFs backfills previously empty PDF text rows. A keyset over file IDs
// guarantees forward progress without repeatedly choosing empty-text PDFs.
func(s *Service) ReindexPDFs(ctx context.Context,batch int)(int,error){
 if batch<1||batch>500{batch=100}
 after:="";count:=0
 for{
  tx,err:=s.uow.Begin(ctx);if err!=nil{return count,err}
  ids,err:=tx.PDFFileIDsAfter(ctx,after,batch)
  _=tx.Rollback(ctx)
  if err!=nil{return count,err}
  if len(ids)==0{return count,nil}
  for _,id:=range ids{
   if err:=ctx.Err();err!=nil{return count,err}
   s.ReindexFile(ctx,id);after=id;count++
  }
 }
}
