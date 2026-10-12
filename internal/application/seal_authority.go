package application

import "filesmanage/internal/domain"

// Admin may use all assigned, active assets. The signing record retains
// the real authenticated operator, never impersonating the asset owner.
func sealCanApply(actor domain.User, asset domain.SealAsset, permission domain.SealUserPermission, hasCompanyGrant bool) bool {
	if !asset.Active {
		return false
	}
	switch asset.Kind {
	case "personal":
		if asset.OwnerID == "" {
			return false
		}
		return actor.IsAdmin || (permission.CanSign && asset.OwnerID == actor.ID)
	case "company":
		return actor.IsAdmin || (permission.CanStamp && hasCompanyGrant)
	default:
		return false
	}
}
