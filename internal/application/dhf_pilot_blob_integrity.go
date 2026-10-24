package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/ports"
	"io"
)

// verifyDHFPilotPhysicalBlob checks real bytes at their immutable storage key,
// not just PostgreSQL version/blob metadata. This is a consistency check at
// submission time, NOT proof that the external filesystem can never be removed
// later. Physical GC, backups and restores require separate controls.
func verifyDHFPilotPhysicalBlob(ctx context.Context, store ports.BlobStore, storageKey, expectedSHA string, expectedSize int64) error {
	if store == nil || storageKey == "" || expectedSize < 0 || len(expectedSHA) != 64 {
		return errors.New("DHF physical evidence unavailable")
	}
	reader, err := store.Open(storageKey)
	if err != nil {
		return errors.New("DHF physical evidence unavailable")
	}
	defer reader.Close()

	hash := sha256.New()
	buf := make([]byte, 64*1024)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := reader.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > expectedSize {
				return errors.New("DHF physical evidence size mismatch")
			}
			_, _ = hash.Write(buf[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return errors.New("DHF physical evidence read failed")
		}
		if n == 0 {
			return errors.New("DHF physical evidence reader made no progress")
		}
	}
	if size != expectedSize || hex.EncodeToString(hash.Sum(nil)) != expectedSHA {
		return errors.New("DHF physical evidence digest mismatch")
	}
	return nil
}
