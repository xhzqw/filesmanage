package application

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Container previews are deliberately bounded and read-only. Untrusted ZIP
// members are NEVER extracted to disk or returned as executable markup.
const maxContainerBytes = 32 << 20
const maxArchiveItems = 200
const maxZIPEntries = 1500
const maxOfficeXMLBytes = 512 << 10
const maxOfficeTextLines = 180

type PreviewEntry struct {
	Name      string `json:"name"`
	Size      uint64 `json:"size"`
	Directory bool   `json:"directory"`
}
type PreviewSection struct {
	Title string   `json:"title"`
	Lines []string `json:"lines"`
}
type StructuredPreview struct {
	Kind      string           `json:"kind"`
	Entries   []PreviewEntry   `json:"entries"`
	Sections  []PreviewSection `json:"sections"`
	Truncated bool             `json:"truncated"`
	Note      string           `json:"note"`
}

func isZIPHeader(header []byte) bool {
	return bytes.HasPrefix(header, []byte("PK")) ||
		bytes.HasPrefix(header, []byte("PK")) ||
		bytes.HasPrefix(header, []byte("PK"))
}

// containerSummary is kept separate from the Preview transport so it can be
// fuzzed/tested independently. No ZipFile.Open or XML decode of arbitrary
// archive entries: only known OOXML paths are ever opened.
func containerSummary(data []byte) (*StructuredPreview, error) {
	if !isZIPHeader(data) {
		return nil, errors.New("not ZIP data")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	if len(zr.File) > maxZIPEntries {
		return &StructuredPreview{Kind: "archive", Note: "文件条目过多，预览仅显示前 200 项", Truncated: true}, nil
	}
	lookup := make(map[string]*zip.File, len(zr.File))
	out := &StructuredPreview{Kind: "archive", Entries: make([]PreviewEntry, 0, min(len(zr.File), maxArchiveItems))}
	for _, f := range zr.File {
		if len(out.Entries) < maxArchiveItems {
			out.Entries = append(out.Entries, PreviewEntry{Name: f.Name, Size: f.UncompressedSize64, Directory: f.FileInfo().IsDir()})
		} else {
			out.Truncated = true
		}
		lookup[f.Name] = f
	}
	sort.Slice(out.Entries, func(i, j int) bool { return out.Entries[i].Name < out.Entries[j].Name })
	if lookup["xl/workbook.xml"] != nil && lookup["[Content_Types].xml"] != nil {
		out.Kind = "spreadsheet"
		out.Entries = nil
		parseSpreadsheet(out, lookup)
	} else if lookup["ppt/presentation.xml"] != nil && lookup["[Content_Types].xml"] != nil {
		out.Kind = "presentation"
		out.Entries = nil
		parsePresentation(out, lookup)
	} else if lookup["word/document.xml"] != nil && lookup["[Content_Types].xml"] != nil {
		out.Kind = "document"
		out.Entries = nil
		parseDocument(out, lookup)
	}
	return out, nil
}

func boundedZIPXML(f *zip.File) ([]byte, error) {
	if f.UncompressedSize64 > maxOfficeXMLBytes {
		return nil, errors.New("XML member too large")
	}
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	b, err := io.ReadAll(io.LimitReader(r, maxOfficeXMLBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxOfficeXMLBytes {
		return nil, errors.New("XML member too large")
	}
	return b, nil
}

func xmlTexts(data []byte, tag string, limit int) ([]string, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var texts []string
	inside := false
	for {
		t, err := dec.Token()
		if err == io.EOF {
			return texts, nil
		}
		if err != nil {
			return nil, err
		}
		switch v := t.(type) {
		case xml.StartElement:
			if v.Name.Local == tag {
				inside = true
			}
		case xml.EndElement:
			if v.Name.Local == tag {
				inside = false
			}
		case xml.CharData:
			if inside && len(texts) < limit {
				value := strings.TrimSpace(string(v))
				if value != "" {
					texts = append(texts, value)
				}
			}
		}
	}
}
func addOfficeNote(out *StructuredPreview, err error) {
	if err != nil {
		out.Note = "文档结构过大或不完整，仅能显示部分内容"
		out.Truncated = true
	}
}
func parsePresentation(out *StructuredPreview, files map[string]*zip.File) {
	type slide struct {
		n    int
		file *zip.File
	}
	slides := []slide{}
	for name, f := range files {
		if !strings.HasPrefix(name, "ppt/slides/slide") || !strings.HasSuffix(name, ".xml") {
			continue
		}
		n, e := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml"))
		if e == nil && n > 0 {
			slides = append(slides, slide{n, f})
		}
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	for _, item := range slides {
		if len(out.Sections) >= 16 {
			out.Truncated = true
			break
		}
		raw, err := boundedZIPXML(item.file)
		if err != nil {
			addOfficeNote(out, err)
			continue
		}
		texts, err := xmlTexts(raw, "t", maxOfficeTextLines)
		if err != nil {
			addOfficeNote(out, err)
			continue
		}
		if len(texts) == 0 {
			texts = []string{"（此页没有可提取的文字）"}
		}
		out.Sections = append(out.Sections, PreviewSection{Title: fmt.Sprintf("第 %d 页", item.n), Lines: texts})
	}
	if len(out.Sections) == 0 && out.Note == "" {
		out.Note = "未找到可读取的幻灯片内容"
	}
}
func parseDocument(out *StructuredPreview, files map[string]*zip.File) {
	raw, err := boundedZIPXML(files["word/document.xml"])
	if err != nil {
		addOfficeNote(out, err)
		return
	}
	texts, err := xmlTexts(raw, "t", maxOfficeTextLines)
	if err != nil {
		addOfficeNote(out, err)
		return
	}
	if len(texts) == 0 {
		texts = []string{"（此文档没有可提取的文字）"}
	}
	out.Sections = []PreviewSection{{Title: "正文摘要", Lines: texts}}
	if len(texts) >= maxOfficeTextLines {
		out.Truncated = true
	}
}
func parseSpreadsheet(out *StructuredPreview, files map[string]*zip.File) {
	shared := []string{}
	if f := files["xl/sharedStrings.xml"]; f != nil {
		if raw, err := boundedZIPXML(f); err == nil {
			// Each <si> joins rich-text runs into one shared-string index.
			dec := xml.NewDecoder(bytes.NewReader(raw))
			inSI, inT := false, false
			var value strings.Builder
			for {
				t, err := dec.Token()
				if err != nil {
					break
				}
				switch v := t.(type) {
				case xml.StartElement:
					if v.Name.Local == "si" {
						inSI = true
						value.Reset()
					}
					if inSI && v.Name.Local == "t" {
						inT = true
					}
				case xml.EndElement:
					if v.Name.Local == "t" {
						inT = false
					}
					if v.Name.Local == "si" {
						if len(shared) < 5000 {
							shared = append(shared, value.String())
						}
						inSI = false
					}
				case xml.CharData:
					if inT && value.Len() < 4096 {
						value.Write([]byte(v))
					}
				}
			}
		} else {
			addOfficeNote(out, err)
		}
	}
	type sheet struct {
		n    int
		file *zip.File
	}
	sheets := []sheet{}
	for name, f := range files {
		if !strings.HasPrefix(name, "xl/worksheets/sheet") || !strings.HasSuffix(name, ".xml") {
			continue
		}
		n, e := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "xl/worksheets/sheet"), ".xml"))
		if e == nil && n > 0 {
			sheets = append(sheets, sheet{n, f})
		}
	}
	sort.Slice(sheets, func(i, j int) bool { return sheets[i].n < sheets[j].n })
	for _, item := range sheets {
		if len(out.Sections) >= 8 {
			out.Truncated = true
			break
		}
		raw, err := boundedZIPXML(item.file)
		if err != nil {
			addOfficeNote(out, err)
			continue
		}
		lines, err := sheetCellLines(raw, shared)
		if err != nil {
			addOfficeNote(out, err)
			continue
		}
		if len(lines) == 0 {
			lines = []string{"（工作表没有可读取的单元格）"}
		}
		if len(lines) >= maxOfficeTextLines {
			out.Truncated = true
		}
		out.Sections = append(out.Sections, PreviewSection{Title: fmt.Sprintf("工作表 %d", item.n), Lines: lines})
	}
	if len(out.Sections) == 0 && out.Note == "" {
		out.Note = "未找到可读取的工作表"
	}
}
func sheetCellLines(raw []byte, shared []string) ([]string, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	lines := []string{}
	var ref, kind, value string
	inCell, inValue := false, false
	for {
		t, err := dec.Token()
		if err == io.EOF {
			return lines, nil
		}
		if err != nil {
			return nil, err
		}
		switch v := t.(type) {
		case xml.StartElement:
			if v.Name.Local == "c" {
				inCell = true
				ref = ""
				kind = ""
				value = ""
				for _, a := range v.Attr {
					switch a.Name.Local {
					case "r":
						ref = a.Value
					case "t":
						kind = a.Value
					}
				}
			}
			if inCell && (v.Name.Local == "v" || v.Name.Local == "t") {
				inValue = true
			}
		case xml.EndElement:
			if v.Name.Local == "v" || v.Name.Local == "t" {
				inValue = false
			}
			if v.Name.Local == "c" {
				if kind == "s" {
					if i, e := strconv.Atoi(strings.TrimSpace(value)); e == nil && i >= 0 && i < len(shared) {
						value = shared[i]
					}
				}
				value = strings.TrimSpace(value)
				if value != "" && len(lines) < maxOfficeTextLines {
					lines = append(lines, fmt.Sprintf("%s  %s", ref, value))
				}
				inCell = false
				if len(lines) >= maxOfficeTextLines {
					return lines, nil
				}
			}
		case xml.CharData:
			if inValue && len(value) < 4096 {
				value += string(v)
			}
		}
	}
}

// ZIP content is an adapter only for stored containers. Other signatures,
// unsupported containers (RAR/7z) and media remain in their existing paths.
func inspectZIP(reader io.ReadSeeker, size int64, name string) (*StructuredPreview, error) {
	if size > maxContainerBytes {
		return &StructuredPreview{Kind: containerKindHint(name), Note: fmt.Sprintf("文件超过 %d MB 的在线结构预览限制，请下载后查看", maxContainerBytes>>20), Truncated: true}, nil
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxContainerBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxContainerBytes {
		return &StructuredPreview{Kind: containerKindHint(name), Note: "文件超过安全读取上限", Truncated: true}, nil
	}
	return containerSummary(data)
}
func containerKindHint(name string) string {
	switch extensionOf(name) {
	case ".xlsx":
		return "spreadsheet"
	case ".pptx":
		return "presentation"
	case ".docx":
		return "document"
	default:
		return "archive"
	}
}
