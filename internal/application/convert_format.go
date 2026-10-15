package application

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"filesmanage/internal/domain"
)

// ConvertFormat creates a new immutable file, never overwriting the source.
// Both the expected content digest and version number fence concurrent edits.
func (s *Service) ConvertFormat(ctx context.Context, u domain.User, id, target string, expectedSeq int, expectedSHA, key string) (UploadResult, error) {
	if target != "pdf" && target != "docx" || expectedSeq < 1 || len(expectedSHA) != 64 || len(key) < 12 || len(key) > 128 {
		return UploadResult{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionDownload)
	if err == nil {
		_, err = s.visibleFile(ctx, tx, u, id, domain.ActionPreview)
	}
	if err == nil {
		_, err = s.activeFolder(ctx, tx, file.FolderID)
	}
	if err == nil {
		err = s.require(ctx, tx, u, file.FolderID, domain.ActionUpload)
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	ext := strings.ToLower(filepath.Ext(file.Name))
	if !((ext == ".docx" && target == "pdf") || (ext == ".pdf" && target == "docx")) {
		return UploadResult{}, ErrPreviewUnsupported
	}
	if currentSeq(file) != expectedSeq || !strings.EqualFold(file.Sha256, expectedSHA) {
		return UploadResult{}, domain.ErrVersionConflict
	}
	src, closeSrc, err := s.openFileBytes(ctx, u, id, domain.ActionDownload)
	if err != nil {
		return UploadResult{}, err
	}
	if !strings.EqualFold(src.Sha256, expectedSHA) || src.FileName != file.Name {
		closeSrc()
		return UploadResult{}, domain.ErrVersionConflict
	}
	var out []byte
	if target == "pdf" {
		out, err = renderOfficePDFSource(ctx, src)
	} else {
		out, err = convertPDFTextToDOCX(ctx, src)
	}
	closeSrc()
	if err != nil {
		return UploadResult{}, err
	}
	// Revalidate after the potentially slow conversion; do not mint a derived
	// document from a now-stale version or a revoked permission.
	check, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	latest, err := s.visibleFile(ctx, check, u, id, domain.ActionDownload)
	if err == nil {
		_, err = s.visibleFile(ctx, check, u, id, domain.ActionPreview)
	}
	if err == nil {
		err = s.require(ctx, check, u, file.FolderID, domain.ActionUpload)
	}
	_ = check.Rollback(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	if latest.FolderID != file.FolderID || currentSeq(latest) != expectedSeq || !strings.EqualFold(latest.Sha256, expectedSHA) {
		return UploadResult{}, domain.ErrVersionConflict
	}
	base := strings.TrimSuffix(file.Name,filepath.Ext(file.Name))
	mime := "application/pdf"
	relation := "docx_to_pdf"
	if target == "docx" {
		mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		relation = "pdf_to_docx"
	}
	return s.commitFriendlyConversion(ctx,u,file.FolderID,base,target,expectedSeq,mime,key,out,
		&domain.FileLineage{SourceFileID:id,SourceFileName:file.Name,SourceVersionSeq:expectedSeq,RelationType:relation})
}

// The PDF importer extracts position-ordered text using Poppler. Its output is
// explicitly a reflowable editable reconstruction, not a lossless reproduction
// of fonts, vector shapes or scanned pages. No shell interpolation is used.
func convertPDFTextToDOCX(ctx context.Context, source Download) ([]byte, error) {
	if source.Size > 24<<20 {
		return nil, ErrPreviewUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pdftotext", "-layout", "-enc", "UTF-8", "-", "-")
	cmd.Stdin = io.LimitReader(source.Reader, 24<<20+1)
	var stdout boundedConversionOutput
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("PDF text extraction failed: %w", err)
	}
	if !utf8.Valid(stdout.Bytes()) || strings.TrimSpace(stdout.String()) == "" {
		return nil, ErrPreviewUnsupported
	}
	return editableTextDOCX(stdout.String())
}

// Reject decompression bombs before accumulating unlimited PDF text.
type boundedConversionOutput struct{ bytes.Buffer }

func (w *boundedConversionOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > 4<<20 {
		return 0, ErrPreviewUnsupported
	}
	return w.Buffer.Write(p)
}

// Produce a strict OOXML package with editable paragraphs (and heading styles).
// Preserve layout-indicating whitespace as text; no HTML is interpreted.
func editableTextDOCX(text string) ([]byte, error) {
	var document strings.Builder
	document.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	body, err := buildPDFDocumentBody(text)
	if err != nil {
		return nil, err
	}
	document.WriteString(body)
	document.WriteString(`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	parts := map[string]string{
		"[Content_Types].xml":          `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
		"_rels/.rels":                  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":            document.String(),
		"word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		"word/styles.xml":              `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="300" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`,
	}
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml"} {
		w, err := z.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err = io.WriteString(w, parts[name]); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
