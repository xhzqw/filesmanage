package application

import "context"

func (r *memoryRepo) TrashEntryRestorable(_ context.Context,entryID,userID string)(bool,error){
	r.mu.Lock()
	defer r.mu.Unlock()
	for _,t:=range r.trash {
		if t.ID==entryID {return t.DeletedBy==userID && t.RestoredAt==nil && t.PurgedAt==nil,nil}
	}
	return false,nil
}
