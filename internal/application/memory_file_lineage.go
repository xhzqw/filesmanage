package application

import (
	"context"
	"filesmanage/internal/domain"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// In-memory lineage implementation keeps converter and access-control unit
// tests compatible with the Postgres-backed lineage contract.
func (r *memoryRepo) InsertFileLineage(_ context.Context, item domain.FileLineage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fileLineages==nil {r.fileLineages=map[string]domain.FileLineage{}}
	item.CreatedAt=time.Now().UTC()
	r.fileLineages[item.ID]=item
	return nil
}
func (r *memoryRepo) FileLineageParent(_ context.Context,id string)(*domain.FileLineage,error){
	r.mu.Lock();defer r.mu.Unlock()
	item,found:=r.fileLineages[id]
	if !found{return nil,nil}
	file:=r.files[id]
	item.Name=file.Name
	item.Ext=strings.TrimPrefix(strings.ToLower(filepath.Ext(file.Name)),".")
	item.VersionSeq=currentSeq(file)
	return &item,nil
}
func (r *memoryRepo) FileLineageChildren(_ context.Context,id string)([]domain.FileLineage,error){
	r.mu.Lock();defer r.mu.Unlock()
	out:=make([]domain.FileLineage,0)
	for _,item:=range r.fileLineages{
		if item.SourceFileID!=id{continue}
		file,ok:=r.files[item.ID]
		if !ok||file.DeletedAt!=nil{continue}
		item.Name=file.Name
		item.Ext=strings.TrimPrefix(strings.ToLower(filepath.Ext(file.Name)),".")
		item.VersionSeq=currentSeq(file)
		out=append(out,item)
	}
	sort.Slice(out,func(i,j int)bool{return out[i].CreatedAt.After(out[j].CreatedAt)})
	return out,nil
}
