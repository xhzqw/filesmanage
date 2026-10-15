package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Rebuild plan bytes from locked database rows at EACH freeze/approval
// boundary. A client-supplied SHA is never accepted as the authority.
func (s *Service) cdwVerifiedDistributionDigest(ctx context.Context, tx ports.Tx,
	snapshot ports.CDWDistributionScopeSnapshot) (string, error) {
	if len(snapshot.Items) != 1 || len(snapshot.Targets) == 0 {
		return "", domain.ErrConflict
	}
	plan := CDWDistributionPlanSnapshot{PlanID: snapshot.PlanID}
	for _, i := range snapshot.Items {
		plan.Items = append(plan.Items, CDWPlanItem{Ordinal: i.Ordinal,
			ReleaseID: i.ReleaseID, ArtifactID: i.ArtifactID, ArtifactSHA256: i.SHA256, Required: i.Required})
	}
	for _, t := range snapshot.Targets {
		if !t.ReceiptRequired || !t.ReadingRequired {
			return "", domain.ErrConflict
		}
		person, err := tx.UserByID(ctx, t.ReceiverID)
		if err != nil || person.DisabledAt != nil || person.DepartmentID != t.DepartmentID {
			return "", domain.ErrForbidden
		}
		if _, err = s.visibleFile(ctx, tx, person, snapshot.FileID, domain.ActionPreview); err != nil {
			return "", domain.ErrForbidden
		}
		plan.Targets = append(plan.Targets, CDWPlanTarget{DepartmentID: t.DepartmentID,
			DesignatedReceiverID: t.ReceiverID, Channel: t.Channel, PaperQuantity: t.PaperQuantity,
			ItemRequirements: []CDWPlanTargetRequirement{{ItemOrdinal: 1,
				ReceiptRequired: t.ReceiptRequired, ReadingRequired: t.ReadingRequired,
				ImplementationRequired: t.ImplementationRequired}}})
	}
	digest, err := CDWCanonicalPlanDigest(plan)
	if err != nil {
		return "", domain.ErrInvalidInput
	}
	return digest, nil
}
