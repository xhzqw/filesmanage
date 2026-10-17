package application

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"strconv"
	"strings"

	"filesmanage/internal/ports"
)

//go:embed dhf_template_source.txt
var dhfFiles embed.FS

func DHFOutline() ports.DHFTemplate {
	raw, err := dhfFiles.ReadFile("dhf_template_source.txt")
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	template := ports.DHFTemplate{Name: strings.TrimSpace(lines[0]), SHA256: hex.EncodeToString(sum[:]), Nodes: make([]ports.DHFNode, 0, len(lines))}
	var stage int
	lineage := map[int]string{}
	for index, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		tabs := len(line) - len(strings.TrimLeft(line, "\t"))
		title := strings.TrimSpace(line)
		if tabs == 1 {
			parts := strings.SplitN(title, "、", 2)
			if len(parts) != 2 {
				continue
			}
			n, e := strconv.Atoi(parts[0])
			if e != nil || n != stage+1 {
				panic("DHF stages must be 1 through 9 in source order")
			}
			stage = n
		}
		if tabs < 1 || stage < 1 {
			continue
		}
		path := []string{}
		for level := 1; level < tabs; level++ {
			path = append(path, lineage[level])
		}
		node := ports.DHFNode{SourceLine: index + 2, StageNo: stage, Depth: tabs, Title: title, ParentPath: path, IsGroup: false}
		if len(template.Nodes) > 0 && tabs > template.Nodes[len(template.Nodes)-1].Depth {
			template.Nodes[len(template.Nodes)-1].IsGroup = true
		}
		template.Nodes = append(template.Nodes, node)
		lineage[tabs] = title
	}
	if stage != 9 {
		panic("DHF template needs exactly nine stages")
	}
	return template
}
