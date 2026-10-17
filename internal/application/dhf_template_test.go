package application

import "testing"

func TestDHFOutlineSourcePreservesStagesAndDuplicates(t *testing.T) {
	t.Parallel()
	v := DHFOutline()
	if v.Name != "产品设计开发DHF（1-9阶段）" || len(v.SHA256) != 64 {
		t.Fatalf("unexpected source: %+v", v)
	}
	counts := make(map[int]int)
	stageCount := 0
	duplicateCount := 0
	seen := make(map[string]int)
	for _, node := range v.Nodes {
		if node.Depth == 1 {
			stageCount++
			if stageCount != node.StageNo {
				t.Fatalf("stage order: %+v", node)
			}
		}
		if node.Depth > 1 && !node.IsGroup {
			counts[node.StageNo]++
			seen[node.Title]++
			if node.SourceLine < 3 {
				t.Fatalf("lost source line: %+v", node)
			}
		}
	}
	if stageCount != 9 {
		t.Fatalf("expected nine stages, got %d", stageCount)
	}
	if counts[1] != 2 || counts[2] != 4 || counts[3] != 7 || counts[4] != 9 || counts[5] < 70 || counts[6] < 9 || counts[7] < 25 || counts[8] != 4 || counts[9] != 6 {
		t.Fatalf("unexpected item breakdown: %+v", counts)
	}
	for _, n := range seen {
		if n > 1 {
			duplicateCount++
		}
	}
	if duplicateCount < 3 {
		t.Fatalf("source duplicates must remain independent: %d", duplicateCount)
	}
}
