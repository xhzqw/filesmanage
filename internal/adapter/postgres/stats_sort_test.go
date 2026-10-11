package postgres

import (
	"testing"

	"filesmanage/internal/domain"
)

func TestStatsMonthBucketsAreChronological(t *testing.T) {
	items := []domain.MonthCount{
		{Month: "2026-10", Count: 1},
		{Month: "2026-01", Count: 100},
		{Month: "2026-08", Count: 7},
	}
	sortMonthCounts(items)
	for i, expected := range []string{"2026-01", "2026-08", "2026-10"} {
		if items[i].Month != expected {
			t.Fatalf("month[%d] = %q, want %q", i, items[i].Month, expected)
		}
	}
}

func TestStatsTypeBucketsRankByCount(t *testing.T) {
	items := []domain.TypeCount{
		{Type: "pdf", Count: 2, Bytes: 1000},
		{Type: "dwg", Count: 9, Bytes: 200},
		{Type: "png", Count: 2, Bytes: 1200},
	}
	sortTypeCounts(items)
	for i, expected := range []string{"dwg", "pdf", "png"} {
		if items[i].Type != expected {
			t.Fatalf("type[%d] = %q, want %q", i, items[i].Type, expected)
		}
	}
}
