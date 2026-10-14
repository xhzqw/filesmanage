package application

import (
	"html"
	"regexp"
	"strings"
)

// Text-based PDF conversion reconstructs simple headings and column-aligned
// tables. It cannot recover scanned content, embedded images or precise layout.
var pdfHeadingLine = regexp.MustCompile(`^(?:第.{1,16}[章节篇]|[一二三四五六七八九十]+[、．.]|[0-9]+(?:\.[0-9]+)*[、．.]\s*\S)`)
var pdfTableSplit = regexp.MustCompile(`\s{2,}`)

func pdfLineCells(line string) []string {
	parts := pdfTableSplit.Split(strings.TrimSpace(line), -1)
	if len(parts) < 2 || len(parts) > 12 {
		return nil
	}
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			return nil
		}
	}
	return parts
}

func writeEditableParagraph(out *strings.Builder, text, style string) {
	out.WriteString("<w:p>")
	if style != "" {
		out.WriteString(`<w:pPr><w:pStyle w:val="` + style + `"/></w:pPr>`)
	}
	out.WriteString(`<w:r><w:t xml:space="preserve">`)
	out.WriteString(html.EscapeString(text))
	out.WriteString("</w:t></w:r></w:p>")
}

func writeEditableTable(out *strings.Builder, rows [][]string) {
	columns := len(rows[0])
	out.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:bottom w:val="single" w:sz="4" w:color="D0D5DD"/><w:insideH w:val="single" w:sz="4" w:color="D0D5DD"/></w:tblBorders></w:tblPr><w:tblGrid>`)
	for c := 0; c < columns; c++ {
		out.WriteString(`<w:gridCol w:w="2400"/>`)
	}
	out.WriteString("</w:tblGrid>")
	for _, row := range rows {
		out.WriteString("<w:tr>")
		for _, cell := range row {
			out.WriteString(`<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>`)
			writeEditableParagraph(out, cell, "")
			out.WriteString("</w:tc>")
		}
		out.WriteString("</w:tr>")
	}
	out.WriteString("</w:tbl>")
}

func buildPDFDocumentBody(text string) (string, error) {
	var document strings.Builder
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\f", "\n"), "\n")
	firstContent := true
	for i := 0; i < len(lines); {
		if document.Len() > 8<<20 {
			return "", ErrPreviewUnsupported
		}
		line := strings.TrimRight(lines[i], "\r")
		cells := pdfLineCells(line)
		if len(cells) > 1 {
			rows := [][]string{cells}
			for k := i + 1; k < len(lines) && len(rows) < 100; k++ {
				candidate := pdfLineCells(lines[k])
				if len(candidate) != len(cells) {
					break
				}
				rows = append(rows, candidate)
			}
			if len(rows) >= 2 {
				writeEditableTable(&document, rows)
				i += len(rows)
				firstContent = false
				continue
			}
		}
		i++
		t := strings.TrimSpace(line)
		style := ""
		if strings.HasPrefix(t, "## ") {
			style = "Heading2"
			t = strings.TrimPrefix(t, "## ")
		} else if strings.HasPrefix(t, "# ") {
			style = "Heading1"
			t = strings.TrimPrefix(t, "# ")
		} else if len([]rune(t)) < 65 && pdfHeadingLine.MatchString(t) {
			style = "Heading2"
		} else if firstContent && len([]rune(t)) > 0 && len([]rune(t)) < 45 && len(line)-len(strings.TrimLeft(line, " ")) >= 5 {
			style = "Heading1"
		}
		if t != "" {
			firstContent = false
		}
		writeEditableParagraph(&document, t, style)
	}
	return document.String(), nil
}
