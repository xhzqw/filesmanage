package application

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func exampleCDWPlan() CDWDistributionPlanSnapshot {
	return CDWDistributionPlanSnapshot{
		PlanID: "plan_1",
		Items: []CDWPlanItem{
			{Ordinal: 2, ReleaseID: "r2", ArtifactID: "a2", ArtifactSHA256: strings.Repeat("b", 64)},
			{Ordinal: 1, ReleaseID: "r1", ArtifactID: "a1", ArtifactSHA256: strings.Repeat("a", 64), Required: true},
		},
		Targets: []CDWPlanTarget{
			{DepartmentID: "d2", DesignatedReceiverID: "u2", Channel: "paper", PaperQuantity: 2,
				ItemRequirements: []CDWPlanTargetRequirement{{ItemOrdinal: 2, ReceiptRequired: true}}},
			{DepartmentID: "d1", DesignatedReceiverID: "u1", Channel: "electronic",
				ItemRequirements: []CDWPlanTargetRequirement{
					{ItemOrdinal: 2, ReadingRequired: true},
					{ItemOrdinal: 1, ReceiptRequired: true, ReadingRequired: true},
				}},
		},
	}
}

func TestCDWCanonicalDigestIgnoresInputOrdering(t *testing.T) {
	first := exampleCDWPlan()
	original, err := CDWCanonicalPlanDigest(first)
	if err != nil {
		t.Fatal(err)
	}
	// The function must not reorder the caller's slices.
	if first.Items[0].Ordinal != 2 || first.Targets[0].DepartmentID != "d2" {
		t.Fatal("canonicalization mutated the snapshot")
	}
	second := exampleCDWPlan()
	second.Items[0], second.Items[1] = second.Items[1], second.Items[0]
	second.Targets[0], second.Targets[1] = second.Targets[1], second.Targets[0]
	second.Targets[0].ItemRequirements[0], second.Targets[0].ItemRequirements[1] =
		second.Targets[0].ItemRequirements[1], second.Targets[0].ItemRequirements[0]
	reordered, err := CDWCanonicalPlanDigest(second)
	if err != nil {
		t.Fatal(err)
	}
	if original != reordered {
		t.Fatalf("semantically equivalent scopes differ: %s vs %s", original, reordered)
	}
}

func TestCDWCanonicalDigestBindsEveryApprovalRelevantField(t *testing.T) {
	baseline, err := CDWCanonicalPlanDigest(exampleCDWPlan())
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*CDWDistributionPlanSnapshot){
		"artifact hash": func(p *CDWDistributionPlanSnapshot) { p.Items[0].ArtifactSHA256 = strings.Repeat("c", 64) },
		"artifact": func(p *CDWDistributionPlanSnapshot) { p.Items[0].ArtifactID = "other" },
		"release": func(p *CDWDistributionPlanSnapshot) { p.Items[0].ReleaseID = "other" },
		"receiver": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].DesignatedReceiverID = "other" },
		"department": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].DepartmentID = "other" },
		"channel": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].Channel = "mixed" },
		"quantity": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].PaperQuantity = 3 },
		"receipt gate": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].ItemRequirements[0].ReceiptRequired = false },
		"reading gate": func(p *CDWDistributionPlanSnapshot) { p.Targets[1].ItemRequirements[0].ReadingRequired = false },
		"implementation gate": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].ItemRequirements[0].ImplementationRequired = true },
		"per-department items": func(p *CDWDistributionPlanSnapshot) {
			p.Targets[1].ItemRequirements = p.Targets[1].ItemRequirements[:1]
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := exampleCDWPlan()
			mutate(&p)
			got, err := CDWCanonicalPlanDigest(p)
			if err != nil {
				t.Fatal(err)
			}
			if got == baseline {
				t.Fatal("approval scope mutation did not change digest")
			}
		})
	}
}

func TestCDWCanonicalPlanRejectsInvalidOrAmbiguousScope(t *testing.T) {
	cases := map[string]func(*CDWDistributionPlanSnapshot){
		"missing items": func(p *CDWDistributionPlanSnapshot) { p.Items = nil },
		"missing target": func(p *CDWDistributionPlanSnapshot) { p.Targets = nil },
		"duplicate item": func(p *CDWDistributionPlanSnapshot) { p.Items[0].Ordinal = 1 },
		"duplicate department": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].DepartmentID = "d1" },
		"bad sha": func(p *CDWDistributionPlanSnapshot) { p.Items[0].ArtifactSHA256 = strings.Repeat("A", 64) },
		"bad quantity": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].PaperQuantity = 0 },
		"missing requirement": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].ItemRequirements = nil },
		"unknown ordinal": func(p *CDWDistributionPlanSnapshot) { p.Targets[0].ItemRequirements[0].ItemOrdinal = 3 },
		"duplicate requirement": func(p *CDWDistributionPlanSnapshot) {
			p.Targets[0].ItemRequirements = append(p.Targets[0].ItemRequirements, p.Targets[0].ItemRequirements[0])
		},
		"invalid utf8": func(p *CDWDistributionPlanSnapshot) { p.PlanID = string([]byte{0xff}) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := exampleCDWPlan()
			mutate(&p)
			if _, err := CDWCanonicalPlanDigest(p); err == nil {
				t.Fatal("accepted invalid scope")
			}
		})
	}
}

func TestCDWCanonicalJSONEncodingJCSSubset(t *testing.T) {
	p := exampleCDWPlan()
	p.PlanID = "plan_</&\u2028\u2029\n"
	encoded, err := CDWCanonicalPlanBytes(p)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(`\u003c`)) || bytes.Contains(encoded, []byte(`\u2028`)) {
		t.Fatalf("not ECMAScript canonical escaping: %s", encoded)
	}
	var object map[string]any
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	if object["planId"] != p.PlanID {
		t.Fatalf("input escaped differently: %#v", object["planId"])
	}
	if !bytes.HasPrefix(encoded, []byte(`{"items":[`)) {
		t.Fatalf("incorrect RFC 8785 object-key order: %s", encoded)
	}
}
