package application

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

func (r *memoryRepo) RecordApprovalEvent(_ context.Context, e domain.ApprovalEvent, recipients []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e.ID = int64(len(r.approvalEvents) + 1)
	e.CreatedAt = time.Now()
	if u, ok := r.users[e.ActorID]; ok {
		e.ActorName = u.user.DisplayName
	}
	r.approvalEvents = append(r.approvalEvents, e)
	seen := map[string]bool{}
	for _, id := range recipients {
		if seen[id] || id == "" {
			continue
		}
		seen[id] = true
		r.approvalNotifications = append(r.approvalNotifications, domain.ApprovalNotification{ID: int64(len(r.approvalNotifications) + 1), ApprovalID: e.ApprovalID, Kind: e.Kind, StepIndex: e.StepIndex, CreatedAt: e.CreatedAt})
		r.approvalNotificationOwners = append(r.approvalNotificationOwners, id)
	}
	return nil
}
func (r *memoryRepo) ListApprovalEvents(_ context.Context, id string) ([]domain.ApprovalEvent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ApprovalEvent, 0)
	for _, e := range r.approvalEvents {
		if e.ApprovalID == id {
			out = append(out, e)
		}
	}
	return out, nil
}
func (r *memoryRepo) ListApprovalNotifications(_ context.Context, user string) ([]domain.ApprovalNotification, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ApprovalNotification, 0)
	for i := len(r.approvalNotifications) - 1; i >= 0; i-- {
		if r.approvalNotificationOwners[i] != user {
			continue
		}
		n := r.approvalNotifications[i]
		for _, a := range r.approvals {
			if a.ID == n.ApprovalID {
				n.FileName = a.FileName
				break
			}
		}
		out = append(out, n)
		if len(out) >= 100 {
			break
		}
	}
	return out, nil
}
func (r *memoryRepo) ListApprovalNotificationPage(_ context.Context,user string,before int64,limit int)([]domain.ApprovalNotification,error){
	r.mu.Lock();defer r.mu.Unlock()
	out:=make([]domain.ApprovalNotification,0)
	for i:=len(r.approvalNotifications)-1;i>=0;i--{
		if r.approvalNotificationOwners[i]!=user{continue}
		n:=r.approvalNotifications[i]
		if before>0&&n.ID>=before{continue}
		for _,a:=range r.approvals{if a.ID==n.ApprovalID{n.FileName=a.FileName;break}}
		out=append(out,n)
		if len(out)==limit{break}
	}
	return out,nil
}
func (r *memoryRepo) CountUnreadApprovalNotifications(_ context.Context,user string)(int,error){
	r.mu.Lock();defer r.mu.Unlock()
	count:=0
	for i,n:=range r.approvalNotifications{if r.approvalNotificationOwners[i]==user&&!n.Read{count++}}
	return count,nil
}

func (r *memoryRepo) ReadApprovalNotification(_ context.Context, user string, id int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, n := range r.approvalNotifications {
		if n.ID == id && r.approvalNotificationOwners[i] == user {
			r.approvalNotifications[i].Read = true
			return true, nil
		}
	}
	return false, nil
}
