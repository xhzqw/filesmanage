package application

import (
	"bytes"
	"encoding/binary"
)

// BrowserMedia identifies passive browser-native formats from a bounded
// signature, never from a client-controlled filename or Content-Type.
// SVG, HTML, and XML are not served as active inline documents.
func BrowserMedia(header []byte) (renderer, mime string) {
	switch {
	case bytes.HasPrefix(header, []byte("\x89PNG\r\n\x1a\n")):
		return "image", "image/png"
	case len(header) >= 3 && bytes.Equal(header[:3], []byte{0xff, 0xd8, 0xff}):
		return "image", "image/jpeg"
	case bytes.HasPrefix(header, []byte("GIF87a")), bytes.HasPrefix(header, []byte("GIF89a")):
		return "image", "image/gif"
	case len(header) >= 12 && bytes.Equal(header[:4], []byte("RIFF")) && bytes.Equal(header[8:12], []byte("WEBP")):
		return "image", "image/webp"
	case len(header) >= 14 && bytes.Equal(header[:2], []byte("BM")):
		return "image", "image/bmp"
	case len(header) >= 16 && bytes.Equal(header[4:8], []byte("ftyp")) &&
		(bytes.Equal(header[8:12], []byte("avif")) || bytes.Equal(header[8:12], []byte("avis"))):
		return "image", "image/avif"
	case isMP4(header):
		return "video", "video/mp4"
	case len(header) >= 16 && bytes.Equal(header[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) &&
		bytes.Contains(header[:min(len(header), 256)], []byte("webm")):
		return "video", "video/webm"
	case len(header) >= 12 && bytes.Equal(header[:4], []byte("RIFF")) && bytes.Equal(header[8:12], []byte("WAVE")):
		return "audio", "audio/wav"
	case bytes.HasPrefix(header, []byte("ID3")) ||
		(len(header) >= 2 && header[0] == 0xff && header[1]&0xe6 == 0xe2):
		return "audio", "audio/mpeg"
	case bytes.HasPrefix(header, []byte("OggS")):
		return "audio", "audio/ogg"
	default:
		return "unsupported", ""
	}
}

func isMP4(header []byte) bool {
	if len(header) < 16 || !bytes.Equal(header[4:8], []byte("ftyp")) {
		return false
	}
	size := binary.BigEndian.Uint32(header[:4])
	if size < 16 || size > uint32(len(header)) || size > 512 {
		return false
	}
	for i := 8; i+4 <= int(size); i += 4 {
		// The four bytes after the major brand are a version, not a brand.
		if i == 12 {
			continue
		}
		switch string(header[i : i+4]) {
		case "isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "MSNV", "dash":
			return true
		}
	}
	return false
}
