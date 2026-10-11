package ports

import (
	"context"
	"filesmanage/internal/domain"
)

type FileLifecycleStore interface {
	FileLifecycleByID(context.Context, string) (domain.FileLifecycle, error)
	UpsertFileLifecycle(context.Context, domain.FileLifecycle) error
}
