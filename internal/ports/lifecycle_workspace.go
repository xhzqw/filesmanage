package ports

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

type LifecycleWorkspaceStore interface {
	ListLifecycleLedger(context.Context, string, string, int, time.Time) ([]domain.LifecycleLedgerRow, error)
	ListLifecycleNotifications(context.Context, string) ([]domain.LifecycleNotification, error)
	ReadLifecycleNotification(context.Context, string, int64) (bool, error)
	HasProtectedLifecycleInFolders(context.Context, []string, time.Time) (bool, error)
}
