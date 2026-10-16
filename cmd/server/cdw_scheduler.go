package main

import (
	"context"
	"errors"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"log"
	"time"
)

// runCDWScheduler only processes explicitly enabled schedules. It does not
// infer consent from a planned date. Lease tokens fence competing instances,
// while Service.CDWRunScheduledActivation performs live sponsor authorization
// and the exact same G8 pointer CAS/manifest checks as a manual activation.
func runCDWScheduler(ctx context.Context, repo *postgres.Repository, service *application.Service) {
	runBatch := func() {
		for i := 0; i < 10 && ctx.Err() == nil; i++ {
			claimCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			claim, found, err := repo.CDWClaimDueActivation(claimCtx)
			cancel()
			if err != nil {
				log.Printf("cdw schedule claim: %v", err)
				return
			}
			if !found {
				return
			}
			execCtx, done := context.WithTimeout(ctx, 75*time.Second)
			decision, activationErr := service.CDWRunScheduledActivation(execCtx, claim)
			done()
			if activationErr == nil {
				log.Printf("cdw schedule evaluated release=%s outcome=%s blockers=%d",
					claim.ReleaseID, decision.Outcome, len(decision.Blockers))
				continue
			}
			permanent := errors.Is(activationErr, domain.ErrForbidden) ||
				errors.Is(activationErr, domain.ErrNotFound) ||
				errors.Is(activationErr, domain.ErrVersionConflict) ||
				errors.Is(activationErr, domain.ErrConflict)
			finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
			finalized, finishErr := repo.CDWScheduleFailClaim(finishCtx, claim.ReleaseID, claim.LeaseToken, permanent)
			finishCancel()
			if finishErr != nil {
				log.Printf("cdw schedule failure evidence write failed release=%s: %v", claim.ReleaseID, finishErr)
			}
			log.Printf("cdw schedule failed release=%s pause=%t finalized=%t: %v",
				claim.ReleaseID, permanent, finalized, activationErr)
		}
	}
	runBatch()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runBatch()
		}
	}
}
