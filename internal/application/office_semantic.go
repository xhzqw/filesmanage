package application

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

// OfficeSemanticLines is intentionally limited: DOCX visible paragraph runs and
// XLSX sheet/cell values (not formatting, formula recomputation, macros or layout).
// It reads bounded ZIP/XML parts and refuses to return truncated comparisons.
func OfficeSemanticLines(data []byte, name string) ([]string, bool) {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(z.File) > compareMaxOfficeEntries {
		return nil, false
	}
	members := map[string]*zip.File{}
	for _, f := range z.File {
		members[f.Name] = f
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx":
		f := members["word/document.xml"]
		if f == nil {
			return nil, false
		}
		raw, err := boundedZIPXML(f)
		if err != nil {
			return nil, false
		}
		dec := xml.NewDecoder(bytes.NewReader(raw))
		lines := make([]string, 0)
		var text strings.Builder
		inParagraph, inText := false, false
		for {
			token, e := dec.Token()
			if e == io.EOF {
				break
			}
			if e != nil {
				return nil, false
			}
			switch t := token.(type) {
			case xml.StartElement:
				if t.Name.Local == "p" && !inParagraph {
					inParagraph = true
					text.Reset()
				}
				if inParagraph && t.Name.Local == "t" {
					inText = true
				}
			case xml.EndElement:
				if t.Name.Local == "t" {
					inText = false
				}
				if t.Name.Local == "p" && inParagraph {
					if text.Len() > 0 {
						lines = append(lines, fmt.Sprintf("¶%d %s", len(lines)+1, text.String()))
					}
					inParagraph = false
					if len(lines) > compareMaxLines {
						return nil, false
					}
				}
			case xml.CharData:
				if inText {
					if text.Len()+len(t) > 8192 {
						return nil, false
					}
					text.Write([]byte(t))
				}
			}
		}
		return lines, len(lines) > 0
	case ".xlsx":
		shared := []string{}
		if f := members["xl/sharedStrings.xml"]; f != nil {
			raw, e := boundedZIPXML(f)
			if e != nil {
				return nil, false
			}
			dec := xml.NewDecoder(bytes.NewReader(raw))
			inSI, inText := false, false
			var b strings.Builder
			for {
				token, e := dec.Token()
				if e == io.EOF {
					break
				}
				if e != nil {
					return nil, false
				}
				switch t := token.(type) {
				case xml.StartElement:
					if t.Name.Local == "si" {
						inSI = true
						b.Reset()
					}
					if inSI && t.Name.Local == "t" {
						inText = true
					}
				case xml.EndElement:
					if t.Name.Local == "t" {
						inText = false
					}
					if t.Name.Local == "si" {
						if len(shared) >= 5000 {
							return nil, false
						}
						shared = append(shared, b.String())
						inSI = false
					}
				case xml.CharData:
					if inText {
						if b.Len()+len(t) > 8192 {
							return nil, false
						}
						b.Write([]byte(t))
					}
				}
			}
		}
		names := []string{}
		for n := range members {
			if strings.HasPrefix(n, "xl/worksheets/") && strings.HasSuffix(n, ".xml") {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		if len(names) == 0 {
			return nil, false
		}
		lines := make([]string, 0)
		for _, n := range names {
			raw, e := boundedZIPXML(members[n])
			if e != nil {
				return nil, false
			}
			cells, e := sheetCellLines(raw, shared)
			if e != nil || len(cells) >= maxOfficeTextLines {
				return nil, false
			}
			for _, line := range cells {
				lines = append(lines, fmt.Sprintf("%s %s", strings.TrimPrefix(n, "xl/worksheets/"), line))
				if len(lines) > compareMaxLines {
					return nil, false
				}
			}
		}
		return lines, len(lines) > 0
	}
	return nil, false
}
