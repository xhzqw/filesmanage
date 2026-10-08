package blob

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Store is the server-controlled content-addressed blob store. User-supplied
// names never reach the filesystem: staging files get random names and ready
// blobs are keyed by their SHA-256.
type Store struct {
	Root string
}

func New(root string) *Store { return &Store{Root: root} }

// Staged is an in-progress upload. Content is streamed to a random staging file
// while its size accumulates; Commit re-digests the file from disk, which makes
// the on-disk bytes the authoritative source for the recorded checksum.
type Staged struct {
	store *Store
	file  *os.File
	path  string
	hash  string
	size  int64
	done  bool
}

// Stage opens a new staging file for streaming.
func (s *Store) Stage() (*Staged, error) {
	if err := os.MkdirAll(filepath.Join(s.Root, "staging"), 0o700); err != nil {
		return nil, err
	}
	name := make([]byte, 16)
	if _, err := rand.Read(name); err != nil {
		return nil, err
	}
	path := filepath.Join(s.Root, "staging", hex.EncodeToString(name))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &Staged{store: s, file: file, path: path}, nil
}

func (st *Staged) Write(p []byte) (int, error) {
	n, err := st.file.Write(p)
	st.size += int64(n)
	return n, err
}

func (st *Staged) Size() int64 { return st.size }

// Sha256 is valid only after a successful Commit.
func (st *Staged) Sha256() string { return st.hash }

// Commit flushes, re-digests the file, renames it into its content-addressed
// ready location and returns the storage key. An identical ready blob is reused
// (deduplicated) and the staging copy is discarded.
func (st *Staged) Commit() (string, bool, error) {
	if st.done {
		return "", false, errors.New("staged upload already finalized")
	}
	if err := st.file.Sync(); err != nil {
		return "", false, err
	}
	if err := st.file.Close(); err != nil {
		return "", false, err
	}
	st.done = true
	digest, err := digestFile(st.path)
	if err != nil {
		return "", false, err
	}
	st.hash = digest
	key := ReadyKey(digest)
	final := filepath.Join(st.store.Root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return "", false, err
	}
	if _, err := os.Stat(final); err == nil {
		if rmErr := os.Remove(st.path); rmErr != nil {
			return "", false, rmErr
		}
		return key, true, nil
	}
	if err := os.Rename(st.path, final); err != nil {
		return "", false, err
	}
	return key, false, nil
}

// ReadFrom streams a finished file into the staging upload.
func (st *Staged) ReadFrom(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(st, file)
	return err
}

// Abort removes the staging file without publishing anything.
func (st *Staged) Abort() error {
	if st.done {
		return nil
	}
	st.done = true
	closeErr := st.file.Close()
	rmErr := os.Remove(st.path)
	if closeErr != nil {
		return closeErr
	}
	return rmErr
}

// ReadyKey is the storage key for a digest: ready/<first2>/<digest>.
func ReadyKey(digest string) string {
	return "ready/" + digest[:2] + "/" + digest
}

// Open resolves a storage key to a readable handle. Keys are constrained to the
// ready namespace so no traversal can escape the blob root.
func (s *Store) Open(storageKey string) (io.ReadSeekCloser, error) {
	if !ValidKey(storageKey) {
		return nil, fmt.Errorf("invalid blob storage key")
	}
	full := filepath.Join(s.Root, filepath.FromSlash(storageKey))
	if !strings.HasPrefix(full, filepath.Join(s.Root, "ready")+string(filepath.Separator)) {
		return nil, fmt.Errorf("blob key escapes ready namespace")
	}
	file, err := os.Open(full)
	if err != nil {
		return nil, err
	}
	return file, nil
}

// PathFor resolves a storage key to an absolute path inside the blob root.
func (s *Store) PathFor(storageKey string) (string, error) {
	if !ValidKey(storageKey) {
		return "", fmt.Errorf("invalid blob storage key")
	}
	return filepath.Join(s.Root, filepath.FromSlash(storageKey)), nil
}

// ValidKey accepts only canonical ready keys: ready/<2 hex>/<64 hex> where the
// shard prefix matches the digest.
func ValidKey(key string) bool {
	if !strings.HasPrefix(key, "ready/") || strings.Contains(key, "..") || strings.HasPrefix(key, "/") {
		return false
	}
	rest := strings.TrimPrefix(key, "ready/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || len(parts[1]) != 64 {
		return false
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return false
	}
	return parts[0] == parts[1][:2]
}

func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
