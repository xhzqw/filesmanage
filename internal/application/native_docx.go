package application

import (
	"archive/zip"
	"bytes"
	"context"
	"filesmanage/internal/domain"
	"fmt"
	"html"
	"io"
	"regexp"
	"strings"
)

const maxNativeDOCXSize = 24 << 20
const maxNativeDocumentXML = 4 << 20

type NativeParagraph struct {
	Text      string `json:"text"`
	Kind      string `json:"kind"`
	TableCell bool   `json:"tableCell"`
}
type NativeDocument struct {
	VersionSeq int               `json:"versionSeq"`
	Paragraphs []NativeParagraph `json:"paragraphs"`
}

var nativeParagraphRE = regexp.MustCompile(`(?s)<w:p(?:\s[^>]*)?>.*?</w:p>`)
var nativeTextRE = regexp.MustCompile(`(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>`)
var nativeHeadingRE = regexp.MustCompile(`<w:pStyle\s+w:val="(Heading1|Heading2|Title)"`)

func extractNativeParagraphs(xmlBody []byte) []NativeParagraph {
	locs := nativeParagraphRE.FindAllIndex(xmlBody, -1)
	blocks := make([]NativeParagraph, 0, len(locs))
	last := 0
	inTable := false
	for _, loc := range locs {
		// Track table scope between paragraph boundaries, including DOCX
		// paragraphs nested inside table cells.
		between := string(xmlBody[last:loc[0]])
		for _, tag := range regexp.MustCompile(`</?w:tbl(?:\s[^>]*)?>`).FindAllString(between, -1) {
			inTable = !strings.HasPrefix(tag, "</")
		}
		paragraph := xmlBody[loc[0]:loc[1]]
		matches := nativeTextRE.FindAllSubmatch(paragraph, -1)
		var text strings.Builder
		for _, m := range matches {
			text.WriteString(html.UnescapeString(string(m[1])))
		}
		kind := "paragraph"
		if match := nativeHeadingRE.FindSubmatch(paragraph); match != nil {
			kind = strings.ToLower(string(match[1]))
		}
		blocks = append(blocks, NativeParagraph{Text: text.String(), Kind: kind, TableCell: inTable})
		last = loc[1]
	}
	return blocks
}

func (s *Service) nativeDOCXBytes(ctx context.Context, u domain.User, id string) ([]byte, int, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	f, err := s.visibleFile(ctx, tx, u, id, domain.ActionModify)
	if err == nil {
		_, err = s.visibleFile(ctx, tx, u, id, domain.ActionPreview)
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return nil, 0, err
	}
	if extensionOf(f.Name) != ".docx" || f.SizeBytes > maxNativeDOCXSize {
		return nil, 0, ErrPreviewUnsupported
	}
	src, done, err := s.openFileBytes(ctx, u, id, domain.ActionDownload)
	if err != nil {
		return nil, 0, err
	}
	defer done()
	if src.Size > maxNativeDOCXSize {
		return nil, 0, ErrPreviewUnsupported
	}
	data, err := io.ReadAll(io.LimitReader(src.Reader, maxNativeDOCXSize+1))
	if err != nil {
		return nil, 0, err
	}
	if len(data) > maxNativeDOCXSize {
		return nil, 0, ErrPreviewUnsupported
	}
	return data, currentSeq(f), nil
}

func loadNativeDocumentXML(raw []byte) ([]byte, error) {
	z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, err
	}
	for _, file := range z.File {
		if file.Name != "word/document.xml" {
			continue
		}
		if file.UncompressedSize64 > maxNativeDocumentXML {
			return nil, ErrPreviewUnsupported
		}
		r, err := file.Open()
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(io.LimitReader(r, maxNativeDocumentXML+1))
		_ = r.Close()
		if readErr != nil {
			return nil, readErr
		}
		if len(body) > maxNativeDocumentXML {
			return nil, ErrPreviewUnsupported
		}
		return body, nil
	}
	return nil, ErrPreviewUnsupported
}

func (s *Service) NativeDOCXContent(ctx context.Context, u domain.User, id string) (NativeDocument, error) {
	raw, seq, err := s.nativeDOCXBytes(ctx, u, id)
	if err != nil {
		return NativeDocument{}, err
	}
	xmlBody, err := loadNativeDocumentXML(raw)
	if err != nil {
		return NativeDocument{}, err
	}
	blocks := extractNativeParagraphs(xmlBody)
	if len(blocks) == 0 || len(blocks) > 10000 {
		return NativeDocument{}, ErrPreviewUnsupported
	}
	return NativeDocument{VersionSeq: seq, Paragraphs: blocks}, nil
}

func replaceNativeParagraphText(old []byte, value string) []byte {
	first := true
	patched := nativeTextRE.ReplaceAllFunc(old, func(match []byte) []byte {
		prefixEnd := bytes.IndexByte(match, '>') + 1
		if prefixEnd == 0 {
			return match
		}
		txt := ""
		if first {
			txt = html.EscapeString(value)
			first = false
		}
		return []byte(string(match[:prefixEnd]) + txt + "</w:t>")
	})
	if first {
		pos := bytes.LastIndex(patched, []byte("</w:p>"))
		if pos >= 0 {
			insert := []byte(`<w:r><w:t xml:space="preserve">` + html.EscapeString(value) + `</w:t></w:r>`)
			patched = append(append(append([]byte{}, patched[:pos]...), insert...), patched[pos:]...)
		}
	}
	return patched
}

func rebuildNativeDOCX(raw []byte, paragraphs []string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, err
	}
	xmlBody, err := loadNativeDocumentXML(raw)
	if err != nil {
		return nil, err
	}
	locs := nativeParagraphRE.FindAllIndex(xmlBody, -1)
	if len(locs) != len(paragraphs) || len(locs) > 10000 {
		return nil, domain.ErrVersionConflict
	}
	original := extractNativeParagraphs(xmlBody)
	if len(original) != len(paragraphs) {
		return nil, domain.ErrVersionConflict
	}
	var patched bytes.Buffer
	start := 0
	for i, loc := range locs {
		if len(paragraphs[i]) > 32768 {
			return nil, domain.ErrInvalidInput
		}
		patched.Write(xmlBody[start:loc[0]])
		if paragraphs[i] == original[i].Text {
			// Leave unchanged runs, hyperlinks, styles and field codes intact.
			patched.Write(xmlBody[loc[0]:loc[1]])
		} else {
			patched.Write(replaceNativeParagraphText(xmlBody[loc[0]:loc[1]], paragraphs[i]))
		}
		start = loc[1]
	}
	patched.Write(xmlBody[start:])
	if patched.Len() > maxNativeDocumentXML {
		return nil, ErrPreviewUnsupported
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	var total int64
	for _, f := range zr.File {
		if f.UncompressedSize64 > 64<<20 {
			return nil, ErrPreviewUnsupported
		}
		total += int64(f.UncompressedSize64)
		if total > 96<<20 {
			return nil, ErrPreviewUnsupported
		}
		w, err := zw.CreateHeader(&f.FileHeader)
		if err != nil {
			return nil, err
		}
		if f.Name == "word/document.xml" {
			if _, err = w.Write(patched.Bytes()); err != nil {
				return nil, err
			}
			continue
		}
		r, err := f.Open()
		if err != nil {
			return nil, err
		}
		_, copyErr := io.Copy(w, io.LimitReader(r, 64<<20+1))
		_ = r.Close()
		if copyErr != nil {
			return nil, copyErr
		}
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("DOCX repack: %w", err)
	}
	return buf.Bytes(), nil
}

// SaveNativeDOCX uses the same edit-lock, approval and immutable-version
// pipeline as all other file saves. Do not replace the original blob in-place.
func (s *Service) SaveNativeDOCX(ctx context.Context, u domain.User, id string, baseSeq int, lockToken, key string, paragraphs []string) (SaveOutcome, error) {
	if baseSeq < 1 || len(paragraphs) == 0 || len(paragraphs) > 10000 {
		return SaveOutcome{}, domain.ErrInvalidInput
	}
	raw, seq, err := s.nativeDOCXBytes(ctx, u, id)
	if err != nil {
		return SaveOutcome{}, err
	}
	if seq != baseSeq {
		return SaveOutcome{}, domain.ErrVersionConflict
	}
	newRaw, err := rebuildNativeDOCX(raw, paragraphs)
	if err != nil {
		return SaveOutcome{}, err
	}
	return s.Save(ctx, u, id, newRaw, baseSeq, lockToken, key)
}
