package ports

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

// Workflow stores cover approval policies, approval requests and edit locks.
// Lock order per SPEC TX-03: folder -> file -> approval -> edit_lock.

type ApprovalPolicyStore interface {
	ApprovalPolicyFor(context.Context, string) (domain.ApprovalPolicy, bool, error)
	UpsertApprovalPolicy(context.Context, domain.ApprovalPolicy) error
	ClearApprovalPolicy(context.Context, string) error
}

type ApprovalStore interface {
	CreateApproval(context.Context, domain.Approval) error
	ApprovalByID(context.Context, string) (domain.Approval, error)
	ListApprovalsForApprover(context.Context, string) ([]domain.Approval, error)
	ListPendingApprovalsForAdmin(context.Context) ([]domain.Approval, error)
	ListApprovalsByRequester(context.Context, string) ([]domain.Approval, error)
	ListApprovalPage(context.Context, string, string, string, int) ([]domain.Approval, error)
	CountPendingApprovals(context.Context, string) (int, error)
	PendingApprovalForFile(context.Context, string) (domain.Approval, bool, error)
	// DecideApproval flips a pending request to its terminal state and reports
	// whether this caller won the transition (false = concurrent decider won).
	DecideApproval(context.Context, string, string, string) (bool, error)
	AdvanceApproval(context.Context, string, int, string) (bool, error)
}

type EditLockStore interface {
	LockByFileID(context.Context, string) (domain.EditLock, error)
	InsertLock(context.Context, domain.EditLock) error
	RenewLock(context.Context, string, string, time.Time, int64) (bool, error)
	ReleaseLock(context.Context, string, string) (bool, error)
	ForceReleaseLock(context.Context, string) (domain.EditLock, error)
}
