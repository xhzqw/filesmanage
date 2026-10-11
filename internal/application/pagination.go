package application

import (
	"encoding/base64"
	"filesmanage/internal/domain"
	"strconv"
	"strings"
	"time"
)

// Cursors carry the sort key plus the id of the last returned row so paging is
// stable even when rows share a timestamp.

func encodeCursor(sort string, last domain.File) string {
	var key string
	switch sort {
	case "relevance":
		key = strconv.Itoa(last.SearchRank) + "\x1f" + last.UpdatedAt.UTC().Format(time.RFC3339Nano) + "\x1f" + last.ID
	case "name_asc", "name_desc":
		key = last.Name + "\x1f" + last.ID
	case "size_desc":
		key = strconv.FormatInt(last.SizeBytes, 10) + "\x1f" + last.ID
	default:
		key = last.UpdatedAt.UTC().Format(time.RFC3339Nano) + "\x1f" + last.ID
	}
	return base64.RawURLEncoding.EncodeToString([]byte(key))
}

// DecodeFileCursor parses a client cursor for the given sort key.
func DecodeFileCursor(sort, encoded string) FileCursor {
	var cursor FileCursor
	if encoded == "" {
		return cursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return cursor
	}
	parts := strings.SplitN(string(raw), "\x1f", 2)
	if len(parts) != 2 {
		return cursor
	}
	if sort == "relevance" {
		fields := strings.Split(string(raw), "\x1f")
		if len(fields) != 3 || fields[2] == "" {
			return cursor
		}
		rank, rankErr := strconv.Atoi(fields[0])
		timestamp, timeErr := time.Parse(time.RFC3339Nano, fields[1])
		if rankErr != nil || timeErr != nil || rank < 0 || rank > 2 {
			return cursor
		}
		cursor.Rank, cursor.Time, cursor.ID = rank, timestamp, fields[2]
		return cursor
	}
	cursor.ID = parts[1]
	switch sort {
	case "name_asc", "name_desc":
		cursor.Name = parts[0]
	case "size_desc":
		cursor.Size, _ = strconv.ParseInt(parts[0], 10, 64)
	default:
		if parsed, perr := time.Parse(time.RFC3339Nano, parts[0]); perr == nil {
			cursor.Time = parsed
		}
	}
	return cursor
}

// Folder cursors follow the file-cursor shape: the sort key of the last returned
// row plus its id, in base64url without padding.

func encodeFolderCursor(last domain.Folder) string {
	return base64.RawURLEncoding.EncodeToString([]byte(last.Name + "\x1f" + last.ID))
}

// DecodeFolderCursor parses a client cursor for the paged folder reads. A cursor
// the server did not issue decodes to the zero value, which starts at the first
// page instead of failing the read.
func DecodeFolderCursor(encoded string) FolderCursor {
	var cursor FolderCursor
	if encoded == "" {
		return cursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return cursor
	}
	parts := strings.SplitN(string(raw), "\x1f", 2)
	if len(parts) != 2 {
		return cursor
	}
	cursor.Name, cursor.ID = parts[0], parts[1]
	return cursor
}
