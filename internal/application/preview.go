package application

import (
	"context"
	"filesmanage/internal/domain"
)

// Preview use case and byte-fidelity helpers (SPEC §8.2). The download endpoint
// remains the authoritative byte stream; preview only renders a bounded copy.

// PreviewLimit caps how many bytes a preview may materialize.
const PreviewLimit = 256 * 1024

type Preview struct {
	FileID      string
	Name        string
	ContentType string
	Size        int64
	Sha256      string
	Content     string
	Truncated   bool
	ByteMeta    ByteMeta
	Textual     bool
}

// ByteMeta records the fidelity facts a consumer must know before editing.
type ByteMeta struct {
	Size      int64  `json:"size"`
	Sha256    string `json:"sha256"`
	Encoding  string `json:"encoding"`
	HasBOM    bool   `json:"hasBom"`
	EOL       string `json:"eol"`
	EndsWithLF bool  `json:"endsWithNewline"`
	Printable bool   `json:"printable"`
}

// AnalyzeBytes is the pure part of preview metadata: encoding, BOM, dominant
// line ending and trailing newline, computed from the raw prefix.
func AnalyzeBytes(data []byte, size int64, sha string) ByteMeta {
	meta := ByteMeta{Size: size, Sha256: sha, Encoding: "utf-8", Printable: isPrintableUTF8(data)}
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		meta.HasBOM = true
		meta.Encoding = "utf-8-bom"
	}
	body := data
	if meta.HasBOM {
		body = data[3:]
	}
	crlf, lf := 0, 0
	for i := range body {
		if body[i] == '\n' {
			if i > 0 && body[i-1] == '\r' {
				crlf++
			} else {
				lf++
			}
		}
	}
	switch {
	case crlf > 0 && lf == 0:
		meta.EOL = "crlf"
	case lf > 0 && crlf == 0:
		meta.EOL = "lf"
	case crlf == 0 && lf == 0:
		meta.EOL = "none"
	default:
		meta.EOL = "mixed"
	}
	meta.EndsWithLF = len(body) > 0 && body[len(body)-1] == '\n'
	return meta
}

func isPrintableUTF8(data []byte) bool {
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return true
}

func looksTextual(name, contentType string) bool {
	if len(contentType) >= 5 && contentType[:5] == "text/" {
		return true
	}
	switch contentType {
	case "application/json", "application/xml", "image/svg+xml":
		return true
	}
	switch extensionOf(name) {
	case ".txt", ".md", ".csv", ".log", ".json", ".xml", ".yaml", ".yml", ".ini", ".toml":
		return true
	}
	return false
}

func extensionOf(name string) string {
	for i := len(name) - 1; i >= 0; i-- {
		if name[i] == '.' {
			return lowerASCII(name[i:])
		}
		if name[i] == '/' || name[i] == '\\' {
			break
		}
	}
	return ""
}

func lowerASCII(s string) string {
	out := []byte(s)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + 32
		}
	}
	return string(out)
}

func (s *Service) Preview(ctx context.Context, u domain.User, fileID string) (Preview, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Preview{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return Preview{}, err
	}
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return Preview{}, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return Preview{}, domain.ErrNotFound
	}
	preview := Preview{
		FileID: file.ID, Name: file.Name, ContentType: file.ContentType,
		Size: blob.SizeBytes, Sha256: blob.Sha256,
		Textual: looksTextual(file.Name, file.ContentType),
	}
	if !preview.Textual {
		preview.ByteMeta = AnalyzeBytes(nil, blob.SizeBytes, blob.Sha256)
		return preview, nil
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Preview{}, err
	}
	defer reader.Close()
	buf := make([]byte, PreviewLimit)
	read := 0
	for read < len(buf) {
		n, err := reader.Read(buf[read:])
		read += n
		if err != nil {
			break
		}
	}
	data := buf[:read]
	preview.Truncated = int64(read) < blob.SizeBytes
	preview.Content = string(data)
	preview.ByteMeta = AnalyzeBytes(data, blob.SizeBytes, blob.Sha256)
	return preview, nil
}
