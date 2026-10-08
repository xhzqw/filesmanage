// Package docx extracts plain text from OOXML .docx containers for the search
// index (SPEC §10.1). It is a bounded, read-only reader: no macros, no external
// entities, no network — only word/document.xml text nodes are collected, and
// callers cap both the container size and the extracted length.
package docx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"
)

// ErrNoDocument reports a zip container without a word/document.xml part.
var ErrNoDocument = errors.New("docx: no word/document.xml part")

// DocumentText returns the paragraph text of a .docx payload. Paragraph and
// line breaks become newlines so snippets keep their shape. An error means the
// payload is not a readable OOXML container; callers then index the file name
// only (SPEC §10.1).
func DocumentText(data []byte, maxBytes int) (string, error) {
	if maxBytes <= 0 || len(data) > maxBytes {
		return "", ErrNoDocument
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	var document *zip.File
	total := uint64(0)
	for _, file := range reader.File {
		total += file.UncompressedSize64
		if total > uint64(maxBytes)*4 {
			return "", ErrNoDocument // refuse zip-bomb shaped containers
		}
		if file.Name == "word/document.xml" {
			document = file
		}
	}
	if document == nil {
		return "", ErrNoDocument
	}
	if document.UncompressedSize64 > uint64(maxBytes) {
		return "", ErrNoDocument
	}
	handle, err := document.Open()
	if err != nil {
		return "", err
	}
	defer handle.Close()
	decoder := xml.NewDecoder(io.LimitReader(handle, int64(maxBytes)))
	var out strings.Builder
	inText := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "t":
				inText = true
			case "p", "br":
				out.WriteByte('\n')
			}
		case xml.EndElement:
			if element.Name.Local == "t" {
				inText = false
			}
		case xml.CharData:
			if inText {
				out.Write(element)
			}
		}
	}
	return out.String(), nil
}
