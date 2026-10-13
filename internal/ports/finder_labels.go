package ports

import (
	"context"
	"filesmanage/internal/domain"
)

type FinderLabelsStore interface {
	SeedFinderLabels(context.Context, string) error
	ListFinderLabels(context.Context, string) ([]domain.FinderLabel, error)
	InsertFinderLabel(context.Context, domain.FinderLabel) error
	UpdateFinderLabel(context.Context, domain.FinderLabel) (bool, error)
	DeleteFinderLabel(context.Context, string, string) (bool, error)
	FinderLabelFileIDs(context.Context, string, string) ([]string, error)
	FinderLabelFolderIDs(context.Context, string, string) ([]string, error)
	FinderFileLabelIDs(context.Context, string, string) ([]string, error)
	FinderFolderLabelIDs(context.Context, string, string) ([]string, error)
	SetFinderFileLabel(context.Context, string, string, bool) error
	SetFinderFolderLabel(context.Context, string, string, bool) error
}
