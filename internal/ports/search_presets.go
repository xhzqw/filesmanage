package ports

import (
	"context"
	"filesmanage/internal/domain"
)

type SearchPresetStore interface {
	ListSearchPresets(context.Context, string) ([]domain.SearchPreset, error)
	UpsertSearchPreset(context.Context, string, domain.SearchPreset) (bool, error)
	DeleteSearchPreset(context.Context, string, string) (bool, error)
}
