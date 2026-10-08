package application

import (
	"context"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"filesmanage/internal/docx"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Search index maintenance (SPEC §10.1): the current signed version of every
// file is indexed on upload, save, approval commit and rollback; trashed and
// pending payloads are never indexed.

// indexTextLimit caps both the bytes read from a blob and the text stored per
// file, so indexing a huge upload cannot blow up memory or the index table.
const indexTextLimit = 1 << 20

// snippetWindow is the character window around a match in search results.
const snippetWindow = 60

// SpaceCJK inserts spaces between adjacent CJK characters so PostgreSQL's
// simple configuration tokenises them (SPEC §10.2). The index writer and the
// query planner use this same function, which is what keeps
// phraseto_tsquery('simple', …) adjacency semantics intact.
func SpaceCJK(s string) string {
	var out strings.Builder
	out.Grow(len(s) + len(s)/2)
	previousCJK := false
	for _, r := range s {
		current := isCJKRune(r)
		if current && previousCJK {
			out.WriteByte(' ')
		}
		out.WriteRune(r)
		previousCJK = current
	}
	return out.String()
}

func isCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

// ExtractText pulls indexable plain text out of file bytes (SPEC §10.1). Text
// formats decode as UTF-8; .docx goes through the bounded OOXML reader; images,
// video, PDF and CAD contribute their file name only.
func ExtractText(name, contentType string, data []byte) string {
	if len(data) == 0 {
		return ""
	}
	if len(data) > indexTextLimit {
		data = data[:indexTextLimit]
	}
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".docx") {
		text, err := docx.DocumentText(data, indexTextLimit)
		if err != nil {
			return ""
		}
		return text
	}
	if looksTextual(name, contentType) && utf8.Valid(data) {
		return string(data) // never index lossy-decoded bytes (SPEC PT-05)
	}
	return ""
}

// ReindexFile refreshes the search index row for a file's current version from
// its immutable blob. It runs after every version-producing transaction so the
// index always matches files.current_version_seq (SPEC §10.1). Indexing is
// best-effort: a failure must never fail the business write that triggered it.
func (s *Service) ReindexFile(ctx context.Context, fileID string) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return
	}
	file, version, blob, readErr := currentVersionBlob(ctx, tx, fileID)
	_ = tx.Rollback(ctx)
	if readErr != nil {
		return
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, indexTextLimit))
	if err != nil {
		return
	}
	_ = version
	text := ExtractText(file.Name, file.ContentType, data)
	s.storeFileText(ctx, fileID, currentSeq(file), text, SpaceCJK(text))
}

func currentVersionBlob(ctx context.Context, repo ports.Repository, fileID string) (domain.File, domain.FileVersion, domain.Blob, error) {
	file, err := repo.FileByID(ctx, fileID)
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	version, err := repo.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	blob, err := repo.BlobByID(ctx, version.BlobID)
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	return file, version, blob, nil
}

// storeFileText upserts the index row for the current version.
func (s *Service) storeFileText(ctx context.Context, fileID string, seq int, text, spaced string) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if err = tx.UpsertFileText(ctx, fileID, seq, text, spaced); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// ReindexAllFiles walks every active file and rebuilds its index row. It backs
// the one-off backfill for databases created before indexing existed, and ops
// recovery after an index corruption.
func (s *Service) ReindexAllFiles(ctx context.Context, batch int) (int, error) {
	if batch <= 0 || batch > 1000 {
		batch = 200
	}
	indexed := 0
	for {
		ids, err := s.fileIDsMissingText(ctx, batch)
		if err != nil {
			return indexed, err
		}
		if len(ids) == 0 {
			return indexed, nil
		}
		for _, id := range ids {
			s.ReindexFile(ctx, id)
			indexed++
		}
	}
}

func (s *Service) fileIDsMissingText(ctx context.Context, limit int) ([]string, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.FileIDsMissingText(ctx, limit)
}
