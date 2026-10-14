package blob

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Upload IDs are generated server-side (upload_<24 lowercase hex>). They are
// never derived from a filename or any client-controlled path component.
var validResumeID = regexp.MustCompile(`^upload_[0-9a-f]{24}$`)

func (s *Store) resumePath(id string) (string, error) {
	if !validResumeID.MatchString(id) {
		return "", errors.New("invalid upload ID")
	}
	return filepath.Join(s.Root, "resumable", id), nil
}
func (s *Store) AppendResumable(id string, offset int64, chunk []byte) error {
	if offset < 0 || len(chunk) == 0 || len(chunk) > 4<<20 {
		return errors.New("invalid chunk")
	}
	path, err := s.resumePath(id)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	// A crash after writing bytes but before the SQL commit may leave a longer
	// spool. Truncation to the DB-authoritative offset repairs it on retry.
	if info.Size() < offset {
		return errors.New("spool shorter than committed offset")
	}
	if err = f.Truncate(offset); err != nil {
		return err
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	if _, err = f.Write(chunk); err != nil {
		return err
	}
	return f.Sync()
}
func (s *Store) OpenResumable(id string) (io.ReadCloser, int64, error) {
	path, err := s.resumePath(id)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, stat.Size(), nil
}
func (s *Store) RemoveResumable(id string) error {
	path, err := s.resumePath(id)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Expired open sessions time out after 24h. A 48h grace window protects
// in-flight/recent sessions from cleanup even if a worker restarts.
func (s *Store) SweepResumable(maxAge time.Duration) (int, error) {
	dir := filepath.Join(s.Root, "resumable")
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || !validResumeID.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if os.Remove(filepath.Join(dir, entry.Name())) == nil {
			removed++
		}
	}
	return removed, nil
}
