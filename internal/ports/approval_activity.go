package ports

import (
	"context"
	"filesmanage/internal/domain"
)

type ApprovalActivityStore interface {
	RecordApprovalEvent(context.Context, domain.ApprovalEvent, []string) error
	ListApprovalEvents(context.Context, string) ([]domain.ApprovalEvent, error)
	ListApprovalNotifications(context.Context, string) ([]domain.ApprovalNotification, error)
	ReadApprovalNotification(context.Context, string, int64) (bool, error)
}
