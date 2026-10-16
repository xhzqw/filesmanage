package domain

import "errors"

// Domain errors mapped to stable HTTP codes by the transport layer.
var (
	ErrUnauthorized           = errors.New("authentication required")
	ErrInvalidInput           = errors.New("invalid input")
	ErrNotFound               = errors.New("resource not found or not visible")
	ErrForbidden              = errors.New("action not granted")
	ErrNameConflict           = errors.New("name already exists in target folder")
	ErrVersionConflict        = errors.New("base version is no longer current")
	ErrLocked                 = errors.New("file is locked by another editor")
	ErrApprovalPending        = errors.New("an approval request is already pending")
	ErrParentMissing          = errors.New("original parent folder no longer exists")
	ErrMoveConflict           = errors.New("move target conflicts with the current location")
	ErrConflict               = errors.New("conflicting state")
	ErrPolicyAuthorityPending = errors.New("formal QMS policy authority basis is pending verification")
	ErrDocumentClassPending   = errors.New("formal document classification must be verified by document control")
	ErrQMSAppointmentPending  = errors.New("formal QMS signer has no independently verified current appointment")
)
