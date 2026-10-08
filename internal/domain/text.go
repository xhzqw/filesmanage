package domain

import "strings"

// Snippet returns a bounded plain-text window around the first case-insensitive
// match of query (SPEC §10.3). The transport layer renders it with safe text
// nodes plus <mark>; nothing here builds HTML. All indexing happens in rune
// space so multibyte content can never produce out-of-range slices.
func Snippet(content, query string, window int) string {
	if content == "" {
		return ""
	}
	runes := []rune(content)
	needle := []rune(strings.ToLower(query))
	if query == "" || len(runes) <= window*2+len(needle) {
		return content
	}
	haystack := []rune(strings.ToLower(content))
	at := -1
	for start := 0; start+len(needle) <= len(haystack); start++ {
		match := true
		for offset := range needle {
			if haystack[start+offset] != needle[offset] {
				match = false
				break
			}
		}
		if match {
			at = start
			break
		}
	}
	if at < 0 {
		return string(runes[:window*2])
	}
	start := at - window
	if start < 0 {
		start = 0
	}
	end := at + len(needle) + window
	if end > len(runes) {
		end = len(runes)
	}
	snippet := string(runes[start:end])
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(runes) {
		snippet += "…"
	}
	return snippet
}
