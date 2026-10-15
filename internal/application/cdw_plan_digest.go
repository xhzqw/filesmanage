package application

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// CDWDistributionPlanSnapshot is the frozen, server-reconstructed approval
// scope. Never use a browser-provided digest as the authoritative scope.
type CDWDistributionPlanSnapshot struct {
	PlanID  string
	Items   []CDWPlanItem
	Targets []CDWPlanTarget
}

type CDWPlanItem struct {
	Ordinal        int
	ReleaseID      string
	ArtifactID     string
	ArtifactSHA256 string
	Required       bool
}

type CDWPlanTarget struct {
	DepartmentID         string
	DesignatedReceiverID string
	Channel              string
	PaperQuantity        int
	ItemRequirements     []CDWPlanTargetRequirement
}

type CDWPlanTargetRequirement struct {
	ItemOrdinal            int
	ReceiptRequired        bool
	ReadingRequired        bool
	ImplementationRequired bool
}

var errCDWInvalidPlan = errors.New("invalid CDW distribution scope")

// CDWCanonicalPlanDigest implements the CDW G1 distribution-plan-v1 digest.
// Its JSON keys are written in RFC 8785 order, with UTF-8 strings encoded
// using JSON.stringify-compatible escaping. Only integers/booleans/strings
// appear in this version; changing the schema requires a NEW schema tag.
func CDWCanonicalPlanDigest(plan CDWDistributionPlanSnapshot) (string, error) {
	canonical, err := CDWCanonicalPlanBytes(plan)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// CDWCanonicalPlanBytes is also useful for a reviewer-facing, byte-for-byte
// comparison of what was actually approved. Input slices are not modified.
func CDWCanonicalPlanBytes(plan CDWDistributionPlanSnapshot) ([]byte, error) {
	if err := validateCDWPlanID(plan.PlanID); err != nil {
		return nil, err
	}
	if len(plan.Items) == 0 || len(plan.Targets) == 0 {
		return nil, fmt.Errorf("%w: no items or targets", errCDWInvalidPlan)
	}
	items := append([]CDWPlanItem(nil), plan.Items...)
	sort.Slice(items, func(i, j int) bool { return items[i].Ordinal < items[j].Ordinal })
	ordinals := make(map[int]struct{}, len(items))
	for _, item := range items {
		if item.Ordinal <= 0 {
			return nil, fmt.Errorf("%w: nonpositive item ordinal", errCDWInvalidPlan)
		}
		if _, exists := ordinals[item.Ordinal]; exists {
			return nil, fmt.Errorf("%w: duplicate item ordinal", errCDWInvalidPlan)
		}
		ordinals[item.Ordinal] = struct{}{}
		if err := validateCDWPlanID(item.ReleaseID); err != nil {
			return nil, err
		}
		if err := validateCDWPlanID(item.ArtifactID); err != nil {
			return nil, err
		}
		if !isLowerSHA256(item.ArtifactSHA256) {
			return nil, fmt.Errorf("%w: invalid artifact sha256", errCDWInvalidPlan)
		}
	}
	targets := append([]CDWPlanTarget(nil), plan.Targets...)
	sort.Slice(targets, func(i, j int) bool {
		return targets[i].DepartmentID < targets[j].DepartmentID
	})
	seenDepartment := map[string]struct{}{}
	var out strings.Builder
	out.WriteString(`{"items":[`)
	for i, item := range items {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"artifactId":`)
		writeCDWJSONString(&out, item.ArtifactID)
		out.WriteString(`,"artifactSha256":`)
		writeCDWJSONString(&out, item.ArtifactSHA256)
		out.WriteString(`,"ordinal":`)
		out.WriteString(strconv.Itoa(item.Ordinal))
		out.WriteString(`,"releaseId":`)
		writeCDWJSONString(&out, item.ReleaseID)
		out.WriteString(`,"required":`)
		writeCDWBool(&out, item.Required)
		out.WriteByte('}')
	}
	out.WriteString(`],"planId":`)
	writeCDWJSONString(&out, plan.PlanID)
	out.WriteString(`,"schema":"cdw-distribution-plan-v1","targets":[`)
	for i, target := range targets {
		if err := validateCDWPlanID(target.DepartmentID); err != nil {
			return nil, err
		}
		if err := validateCDWPlanID(target.DesignatedReceiverID); err != nil {
			return nil, err
		}
		if _, exists := seenDepartment[target.DepartmentID]; exists {
			return nil, fmt.Errorf("%w: duplicate target department", errCDWInvalidPlan)
		}
		seenDepartment[target.DepartmentID] = struct{}{}
		if target.PaperQuantity < 0 ||
			(target.Channel == "electronic" && target.PaperQuantity != 0) ||
			((target.Channel == "paper" || target.Channel == "mixed") && target.PaperQuantity == 0) ||
			(target.Channel != "electronic" && target.Channel != "paper" && target.Channel != "mixed") {
			return nil, fmt.Errorf("%w: invalid channel or paper quantity", errCDWInvalidPlan)
		}
		if len(target.ItemRequirements) == 0 {
			return nil, fmt.Errorf("%w: empty target item scope", errCDWInvalidPlan)
		}
		requirements := append([]CDWPlanTargetRequirement(nil), target.ItemRequirements...)
		sort.Slice(requirements, func(a, b int) bool {
			return requirements[a].ItemOrdinal < requirements[b].ItemOrdinal
		})
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"channel":`)
		writeCDWJSONString(&out, target.Channel)
		out.WriteString(`,"departmentId":`)
		writeCDWJSONString(&out, target.DepartmentID)
		out.WriteString(`,"designatedReceiverId":`)
		writeCDWJSONString(&out, target.DesignatedReceiverID)
		out.WriteString(`,"itemRequirements":[`)
		seenItem := map[int]struct{}{}
		for j, req := range requirements {
			if _, exists := ordinals[req.ItemOrdinal]; !exists {
				return nil, fmt.Errorf("%w: target references unapproved item", errCDWInvalidPlan)
			}
			if _, exists := seenItem[req.ItemOrdinal]; exists {
				return nil, fmt.Errorf("%w: duplicate target item", errCDWInvalidPlan)
			}
			seenItem[req.ItemOrdinal] = struct{}{}
			if j > 0 {
				out.WriteByte(',')
			}
			out.WriteString(`{"implementationRequired":`)
			writeCDWBool(&out, req.ImplementationRequired)
			out.WriteString(`,"itemOrdinal":`)
			out.WriteString(strconv.Itoa(req.ItemOrdinal))
			out.WriteString(`,"readingRequired":`)
			writeCDWBool(&out, req.ReadingRequired)
			out.WriteString(`,"receiptRequired":`)
			writeCDWBool(&out, req.ReceiptRequired)
			out.WriteByte('}')
		}
		out.WriteString(`],"paperQuantity":`)
		out.WriteString(strconv.Itoa(target.PaperQuantity))
		out.WriteByte('}')
	}
	out.WriteString("]}")
	return []byte(out.String()), nil
}

func validateCDWPlanID(s string) error {
	if strings.TrimSpace(s) == "" || !utf8.ValidString(s) {
		return fmt.Errorf("%w: invalid identifier", errCDWInvalidPlan)
	}
	return nil
}

func isLowerSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, b := range []byte(s) {
		if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f') {
			return false
		}
	}
	return true
}

func writeCDWBool(out *strings.Builder, b bool) {
	if b {
		out.WriteString("true")
	} else {
		out.WriteString("false")
	}
}

// RFC 8785 uses ECMAScript JSON string escaping rather than Go's default
// HTML-safe JSON escaping (which would produce different digests for <, &,
// U+2028 and U+2029).
func writeCDWJSONString(out *strings.Builder, s string) {
	out.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteString(fmt.Sprintf("%02x", r))
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}
