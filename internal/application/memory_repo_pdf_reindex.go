package application
import("context";"sort";"strings")
func(r *memoryRepo) PDFFileIDsAfter(_ context.Context,after string,limit int)([]string,error){
 r.mu.Lock();defer r.mu.Unlock()
 ids:=make([]string,0)
 for _,f:=range r.files{if f.ID>after&&f.DeletedAt==nil&&strings.HasSuffix(strings.ToLower(f.Name),".pdf"){ids=append(ids,f.ID)}}
 sort.Strings(ids);if len(ids)>limit{ids=ids[:limit]};return ids,nil
}
