package application

import (
	"context"
	"encoding/base64"
	"errors"
	"io"

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
	Renderer    string
	MediaType   string
	RawBase64   string
	Structured  *StructuredPreview
}

var ErrPreviewUnsupported = errors.New("inline preview format not supported")

// ByteMeta records the fidelity facts a consumer must know before editing.
type ByteMeta struct {
	Size       int64  `json:"size"`
	Sha256     string `json:"sha256"`
	Encoding   string `json:"encoding"`
	HasBOM     bool   `json:"hasBom"`
	EOL        string `json:"eol"`
	EndsWithLF bool   `json:"endsWithNewline"`
	Printable  bool   `json:"printable"`
	RawBase64  string `json:"rawBase64,omitempty"`
}

// AnalyzeBytes is the pure part of preview metadata: encoding, BOM, dominant
// line ending and trailing newline, computed from the raw bytes so no decoding
// step can silently rewrite them.
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

// PreviewBytes renders a bounded text preview from raw bytes. The returned
// content is the exact decoded prefix (BOM stripped for display only) and the
// metadata describes the original bytes; editors must round-trip through
// rawBase64 so nothing is normalised.
func PreviewBytes(data []byte, size int64, sha string) (string, ByteMeta) {
	meta := AnalyzeBytes(data, size, sha)
	display := data
	if meta.HasBOM {
		display = data[3:]
	}
	return string(display), meta
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
	case ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".jsonl",
		".xml", ".yaml", ".yml", ".ini", ".toml", ".conf", ".cfg",
		".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".htm",
		".py", ".go", ".rs", ".java", ".sql", ".sh", ".bash", ".ps1",
		".c", ".cpp", ".h", ".hpp", ".gcode", ".srt", ".vtt":
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
	file, blob, _, err := s.resolveUserFacingVersion(ctx, tx, file)
	if err != nil {
		return Preview{}, err
	}
	return s.previewBlob(file, blob)
}

// previewBlob shares the exact committed-version preview pipeline with staged drafts.
func (s *Service) previewBlob(file domain.File, blob domain.Blob) (Preview, error) {
	preview := Preview{
		FileID: file.ID, Name: file.Name, ContentType: file.ContentType,
		Size: blob.SizeBytes, Sha256: blob.Sha256,
		Textual: looksTextual(file.Name, file.ContentType), Renderer: "unsupported",
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Preview{}, err
	}
	defer reader.Close()
	header := make([]byte, 512)
	n, readErr := io.ReadFull(reader, header)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		return Preview{}, readErr
	}
	preview.Renderer, preview.MediaType = BrowserMedia(header[:n])
	if preview.Renderer != "unsupported" {
		preview.Textual = false
		preview.ByteMeta = AnalyzeBytes(nil, blob.SizeBytes, blob.Sha256)
		return preview, nil
	}
	if isZIPHeader(header[:n]) {
		preview.Textual = false
		preview.ByteMeta = AnalyzeBytes(nil, blob.SizeBytes, blob.Sha256)
		preview.Structured, err = inspectZIP(reader, blob.SizeBytes, file.Name)
		if err != nil {
			preview.Structured = &StructuredPreview{Kind: "archive", Note: "压缩包结构损坏或无法读取；请下载后使用可信工具检查"}
		}
		preview.Renderer = preview.Structured.Kind
		return preview, nil
	}
	if !preview.Textual {
		preview.ByteMeta = AnalyzeBytes(nil, blob.SizeBytes, blob.Sha256)
		return preview, nil
	}
	preview.Renderer = "text"
	if _, err = reader.Seek(0, io.SeekStart); err != nil {
		return Preview{}, err
	}
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
	preview.Content, preview.ByteMeta = PreviewBytes(data, blob.SizeBytes, blob.Sha256)
	preview.RawBase64 = base64.StdEncoding.EncodeToString(data)
	return preview, nil
}

// OpenInlinePreview streams only signature-verified passive media. Each
// request, including Range requests, re-evaluates the preview ACL.
func (s *Service) OpenInlinePreview(ctx context.Context, u domain.User, fileID string) (Download, string, func(), error) {
	download, done, err := s.openFileBytes(ctx, u, fileID, domain.ActionPreview)
	if err != nil {
		return Download{}, "", nil, err
	}
	header := make([]byte, 512)
	n, readErr := io.ReadFull(download.Reader, header)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		done()
		return Download{}, "", nil, readErr
	}
	renderer, mime := BrowserMedia(header[:n])
	if renderer == "unsupported" {
		done()
		return Download{}, "", nil, ErrPreviewUnsupported
	}
	if _, err := download.Reader.Seek(0, io.SeekStart); err != nil {
		done()
		return Download{}, "", nil, err
	}
	download.ContentType = mime
	return download, renderer, done, nil
}
