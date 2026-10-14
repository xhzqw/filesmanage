package postgres

import (
	"fmt"
	"testing"
	"time"
)

// favoriteSelect uses coalesce on both LEFT JOIN names, so both scan
// destinations are non-nil even though only one resource kind is present.
// This fixture deliberately reproduces that result without a database.
type favoriteJoinedRow struct {
	fileID     *string
	folderID   *string
	fileName   string
	folderName string
}

func (row favoriteJoinedRow) Scan(dest ...any) error {
	if len(dest) != 10 {
		return fmt.Errorf("favorite scan destinations: got %d, want 10", len(dest))
	}
	*dest[0].(*string) = "fav-test"
	*dest[1].(*string) = "user-test"
	*dest[2].(**string) = row.fileID
	*dest[3].(**string) = row.folderID
	*dest[4].(*time.Time) = time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	*dest[5].(**string) = &row.fileName
	*dest[6].(**string) = &row.folderName
	*dest[7].(*bool) = false
	*dest[8].(*string) = ""
	*dest[9].(*string) = ""
	return nil
}

func TestScanFavoriteUsesResourceKindToChooseName(t *testing.T) {
	fileID, folderID := "file_123", "folder_123"
	for _, tc := range []struct {
		name string
		row  favoriteJoinedRow
		want string
	}{
		{"file", favoriteJoinedRow{fileID: &fileID, fileName: "报告.docx"}, "报告.docx"},
		{"folder", favoriteJoinedRow{folderID: &folderID, folderName: "市场部"}, "市场部"},
		{"folder with both names populated", favoriteJoinedRow{
			folderID: &folderID, fileName: "不应显示", folderName: "研发部",
		}, "研发部"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := scanFavorite(tc.row)
			if err != nil {
				t.Fatal(err)
			}
			if got.ResourceName != tc.want {
				t.Fatalf("resource name = %q, want %q", got.ResourceName, tc.want)
			}
		})
	}
}
