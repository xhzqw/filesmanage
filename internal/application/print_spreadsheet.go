package application

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"strings"

	"filesmanage/internal/domain"
)

type PrintSheet struct {
	Name string `json:"name"`
}

type workbookSheet struct {
	name    string
	visible bool
	start   int
	end     int
}

var sheetStateAttribute = regexp.MustCompile(`\sstate\s*=\s*(?:"[^"]*"|'[^']*')`)

// Read only the workbook's declared sheet names, rather than assuming that
// sheet1.xml is the first named worksheet. XML is never rendered as HTML.
func workbookSheets(data []byte) ([]workbookSheet, error) {
	zr, err := zipPackageIndex(data)
	if err != nil {
		return nil, err
	}
	var workbook *zip.File
	for _, entry := range zr.File {
		if entry.Name == "xl/workbook.xml" {
			workbook = entry
			break
		}
	}
	if workbook == nil {
		return nil, ErrPreviewUnsupported
	}
	raw, err := boundedZIPXML(workbook)
	if err != nil {
		return nil, ErrPreviewUnsupported
	}
	dec := xml.NewDecoder(bytes.NewReader(raw))
	depth := 0
	var sheets []workbookSheet
	seen := map[string]bool{}
	for {
		before := int(dec.InputOffset())
		token, e := dec.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, ErrPreviewUnsupported
		}
		after := int(dec.InputOffset())
		switch v := token.(type) {
		case xml.StartElement:
			if depth == 0 && v.Name.Local == "sheets" {
				depth = 1
				continue
			}
			if depth > 0 {
				depth++
				if depth != 2 || v.Name.Local != "sheet" {
					continue
				}
				var name, state string
				for _, attr := range v.Attr {
					switch attr.Name.Local {
					case "name":
						name = attr.Value
					case "state":
						state = attr.Value
					}
				}
				if name == "" || len(name) > 200 || seen[name] || len(sheets) >= 64 {
					return nil, ErrPreviewUnsupported
				}
				seen[name] = true
				sheets = append(sheets, workbookSheet{name: name, visible: state == "" || state == "visible", start: before, end: after})
			}
		case xml.EndElement:
			if depth > 0 {
				depth--
			}
		}
	}
	if len(sheets) == 0 {
		return nil, ErrPreviewUnsupported
	}
	return sheets, nil
}

func selectWorkbookSheet(data []byte, name string) ([]byte, error) {
	if name == "" || len(name) > 200 {
		return nil, ErrInvalidInput
	}
	sheets, err := workbookSheets(data)
	if err != nil {
		return nil, err
	}
	found := false
	for _, sheet := range sheets {
		if sheet.name == name && sheet.visible {
			found = true
			break
		}
	}
	if !found {
		return nil, ErrInvalidInput
	}
	zr, err := zipPackageIndex(data)
	if err != nil {
		return nil, err
	}
	var result bytes.Buffer
	out := zip.NewWriter(&result)
	for _, entry := range zr.File {
		header := entry.FileHeader
		writer, e := out.CreateHeader(&header)
		if e != nil {
			return nil, ErrPreviewUnsupported
		}
		reader, e := entry.Open()
		if e != nil {
			return nil, ErrPreviewUnsupported
		}
		if entry.Name == "xl/workbook.xml" {
			raw, e := io.ReadAll(io.LimitReader(reader, maxOfficeXMLBytes+1))
			reader.Close()
			if e != nil || len(raw) > maxOfficeXMLBytes {
				return nil, ErrPreviewUnsupported
			}
			var patched bytes.Buffer
			from := 0
			for _, sheet := range sheets {
				if sheet.start < from || sheet.end > len(raw) {
					return nil, ErrPreviewUnsupported
				}
				patched.Write(raw[from:sheet.start])
				tag := raw[sheet.start:sheet.end]
				// Hiding unselected sheets is not honored consistently by LibreOffice
				// PDF export. Omit the other <sheet/> declarations entirely in the
				// disposable workbook manifest; source ZIP remains immutable.
				if sheet.name != name {
					if !bytes.HasSuffix(bytes.TrimSpace(tag), []byte("/>")) {
						return nil, ErrPreviewUnsupported
					}
					from = sheet.end
					continue
				}
				replacement := []byte(" state=\"visible\"")
				if indexes := sheetStateAttribute.FindIndex(tag); indexes != nil {
					tag = append(append(append([]byte{}, tag[:indexes[0]]...), replacement...), tag[indexes[1]:]...)
				} else {
					at := bytes.LastIndexByte(tag, '>')
					if at < 0 {
						return nil, ErrPreviewUnsupported
					}
					if at > 0 && tag[at-1] == '/' {
						at--
					}
					tag = append(append(append([]byte{}, tag[:at]...), replacement...), tag[at:]...)
				}
				patched.Write(tag)
				from = sheet.end
			}
			patched.Write(raw[from:])
			if _, e = writer.Write(patched.Bytes()); e != nil {
				return nil, e
			}
		} else {
			_, e = io.Copy(writer, reader)
			reader.Close()
			if e != nil {
				return nil, e
			}
		}
		if result.Len() > maxOfficeSourceBytes {
			return nil, ErrPreviewUnsupported
		}
	}
	if err = out.Close(); err != nil {
		return nil, err
	}
	if result.Len() > maxOfficeSourceBytes {
		return nil, ErrPreviewUnsupported
	}
	return result.Bytes(), nil
}

func (s *Service) BrowserPrintSheets(ctx context.Context, u domain.User, id, sha string) ([]PrintSheet, error) {
	if len(sha) != 64 {
		return nil, ErrInvalidInput
	}
	source, done, err := s.openBrowserPrintSource(ctx, u, id, sha)
	if err != nil {
		return nil, err
	}
	defer done()
	if !strings.EqualFold(extensionOf(source.FileName), ".xlsx") || source.Size <= 0 || source.Size > maxOfficeSourceBytes {
		return nil, ErrPreviewUnsupported
	}
	data, err := io.ReadAll(io.LimitReader(source.Reader, maxOfficeSourceBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxOfficeSourceBytes {
		return nil, ErrPreviewUnsupported
	}
	sheets, err := workbookSheets(data)
	if err != nil {
		return nil, err
	}
	out := make([]PrintSheet, 0, len(sheets))
	for _, sheet := range sheets {
		if sheet.visible {
			out = append(out, PrintSheet{Name: sheet.name})
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no visible worksheets")
	}
	return out, nil
}
