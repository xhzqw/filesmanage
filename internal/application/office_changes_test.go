package application

import (
	"testing"
)

func TestOfficeSemanticChangesCellsAndParagraphs(t *testing.T) {
	tests := []struct {
		kind     string
		old, new []string
		want     []string
	}{
		{".xlsx", []string{"sheet1.xml A1  Old", "sheet1.xml B2  Removed", "sheet2.xml C3  Stay"}, []string{"sheet1.xml A1  New", "sheet1.xml D4  Added", "sheet2.xml C3  Stay"}, []string{"changed", "removed", "added"}},
		{".docx", []string{"¶1 First", "¶2 Legacy"}, []string{"¶1 First", "¶2 Modern", "¶3 Next"}, []string{"changed", "added"}},
	}
	for _, tc := range tests {
		actual, ok := OfficeSemanticChanges(tc.old, tc.new, tc.kind)
		if !ok || len(actual) != len(tc.want) {
			t.Fatalf("case %s diff %+v %v", tc.kind, actual, ok)
		}
		for i, want := range tc.want {
			if actual[i].Kind != want {
				t.Fatalf("case %s index %d %+v", tc.kind, i, actual[i])
			}
		}
	}
	if _, ok := OfficeSemanticChanges([]string{"sheet1.xml A1  x", "sheet1.xml A1  y"}, nil, ".xlsx"); ok {
		t.Fatal("duplicate location accepted")
	}
	if _, ok := OfficeSemanticChanges([]string{"invalid coordinate"}, nil, ".xlsx"); ok {
		t.Fatal("invalid coordinate accepted")
	}
}
