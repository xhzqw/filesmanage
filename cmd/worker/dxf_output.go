package main

import (
	"bufio"
	"errors"
	"os"
	"strings"
)

// outputHasDxfGeometry rejects empty/malformed converter results. Scan
// group-code pairs instead of buffering CAD data in the server heap.
func outputHasDxfGeometry(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return false, err
	}
	if stat.Size() == 0 || stat.Size() > 256<<20 {
		return false, errors.New("DXF conversion output is empty or exceeds preview limit")
	}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	inEntities, awaitSectionName, hasGeometry, ended := false, false, false, false
	for scanner.Scan() {
		code := strings.TrimSpace(scanner.Text())
		if !scanner.Scan() {
			return false, errors.New("DXF output has an incomplete group pair")
		}
		value := strings.TrimSpace(scanner.Text())
		if awaitSectionName {
			if code == "2" && value == "ENTITIES" {
				inEntities = true
			}
			awaitSectionName = false
		}
		if code != "0" {
			continue
		}
		switch value {
		case "SECTION":
			awaitSectionName = true
		case "ENDSEC":
			inEntities = false
		case "EOF":
			ended = true
		default:
			if inEntities {
				switch value {
				case "LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE",
					"TEXT", "MTEXT", "INSERT", "DIMENSION", "HATCH", "POINT", "SOLID", "TRACE", "3DFACE":
					hasGeometry = true
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return false, err
	}
	return hasGeometry && ended, nil
}
