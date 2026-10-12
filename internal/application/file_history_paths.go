package application

import (
	"context"
	"filesmanage/internal/ports"
	"strings"
)

// Capture the actual path at event time. Reconstructing it later from current
// folder state would make old move records factually incorrect.
func historicalFolderPath(ctx context.Context, repo ports.Repository, folderID string) (string, error) {
	trail, err := snapshotTrashPath(ctx, repo, folderID)
	if err != nil {
		return "", err
	}
	parts := make([]string, 0, len(trail))
	for _, part := range trail {
		parts = append(parts, part.Name)
	}
	return "/" + strings.Join(parts, "/"), nil
}
