package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// In-memory workflow stores for unit tests: policies, approvals, locks.

func (r *memoryRepo) ApprovalPolicyFor(_ context.Context, folderID string) (domain.ApprovalPolicy, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.policies[folderID]
	return p, ok, nil
}

func (r *memoryRepo) UpsertApprovalPolicy(_ context.Context, p domain.ApprovalPolicy) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.users[p.ApproverID]; !ok {
		return domain.ErrInvalidInput
	}
	for _,id:=range p.ApproverChain{if _,ok:=r.users[id];!ok{return domain.ErrInvalidInput}}
	r.policies[p.FolderID] = p
	return nil
}

func (r *memoryRepo) ClearApprovalPolicy(_ context.Context, folderID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.policies, folderID)
	return nil
}

func (r *memoryRepo) CreateApproval(_ context.Context, a domain.Approval) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.approvals {
		if existing.FileID == a.FileID && existing.State == domain.ApprovalPending {
			return domain.ErrApprovalPending
		}
	}
	r.approvals = append(r.approvals, a)
	return nil
}

func (r *memoryRepo) ApprovalByID(_ context.Context, id string) (domain.Approval, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.approvals {
		if a.ID == id {
			return a, nil
		}
	}
	return domain.Approval{}, ports.ErrRowMissing
}

func (r *memoryRepo) ListApprovalsForApprover(_ context.Context, approverID string) ([]domain.Approval, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Approval, 0)
	for _, a := range r.approvals {
		if a.ApproverID == approverID && a.State == domain.ApprovalPending {
			out = append(out, a)
		}
	}
	return out, nil
}

func (r *memoryRepo) ListApprovalsByRequester(_ context.Context, requesterID string) ([]domain.Approval, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Approval, 0)
	for _, a := range r.approvals {
		if a.RequesterID == requesterID {
			out = append(out, a)
		}
	}
	return out, nil
}

func (r *memoryRepo) PendingApprovalForFile(_ context.Context, fileID string) (domain.Approval, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.approvals {
		if a.FileID == fileID && a.State == domain.ApprovalPending {
			return a, true, nil
		}
	}
	return domain.Approval{}, false, nil
}

func (r *memoryRepo) DecideApproval(_ context.Context, id, state, comment string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, a := range r.approvals {
		if a.ID == id {
			if a.State != domain.ApprovalPending {
				return false, nil
			}
			r.approvals[i].State = state
			r.approvals[i].DecisionComment = comment
			now := time.Now()
			r.approvals[i].DecidedAt = &now
			return true, nil
		}
	}
	return false, ports.ErrRowMissing
}

func (r *memoryRepo) AdvanceApproval(_ context.Context,id string,step int,nextID string)(bool,error){
 r.mu.Lock();defer r.mu.Unlock()
 for i:=range r.approvals{
  a:=&r.approvals[i]
  if a.ID!=id{continue}
  if a.State!=domain.ApprovalPending||a.StepIndex!=step||a.ApproverID!=a.ApproverChain[step]{return false,nil}
  a.StepIndex++;a.ApproverID=nextID
  return true,nil
 }
 return false,ports.ErrRowMissing
}

func (r *memoryRepo) LockByFileID(_ context.Context, fileID string) (domain.EditLock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[fileID]
	if !ok {
		return domain.EditLock{}, ports.ErrRowMissing
	}
	return lock, nil
}

func (r *memoryRepo) InsertLock(_ context.Context, l domain.EditLock) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.locks[l.FileID]; ok {
		return domain.ErrLocked
	}
	r.locks[l.FileID] = l
	return nil
}

func (r *memoryRepo) RenewLock(_ context.Context, fileID, tokenHash string, expires time.Time, generation int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[fileID]
	if !ok || lock.TokenHash != tokenHash || lock.Generation != generation || !lock.ExpiresAt.After(time.Now()) {
		return false, nil
	}
	lock.ExpiresAt = expires
	r.locks[fileID] = lock
	return true, nil
}

func (r *memoryRepo) ReleaseLock(_ context.Context, fileID, tokenHash string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[fileID]
	if !ok || lock.TokenHash != tokenHash {
		return false, nil
	}
	delete(r.locks, fileID)
	return true, nil
}

func (r *memoryRepo) ForceReleaseLock(_ context.Context, fileID string) (domain.EditLock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[fileID]
	if !ok {
		return domain.EditLock{}, ports.ErrRowMissing
	}
	delete(r.locks, fileID)
	return lock, nil
}

var _ = errors.Is
