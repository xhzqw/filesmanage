package application

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"filesmanage/internal/domain"
)

func testMP4() []byte {
	return append([]byte{0, 0, 0, 24}, []byte("ftypisom\x00\x00\x00\x00mp41isomfake-media-payload")...)
}

func TestBrowserMediaSignatures(t *testing.T) {
	cases := []struct {
		name, renderer, mime string
		data                 []byte
	}{
		{"png", "image", "image/png", append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)},
		{"jpeg", "image", "image/jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}},
		{"gif", "image", "image/gif", []byte("GIF89a")},
		{"webp", "image", "image/webp", []byte("RIFF\x00\x00\x00\x00WEBP")},
		{"bmp", "image", "image/bmp", append([]byte("BM"), bytes.Repeat([]byte{0}, 14)...)},
		{"avif", "image", "image/avif", []byte("\x00\x00\x00\x18ftypavif\x00\x00\x00\x00")},
		{"mp4", "video", "video/mp4", testMP4()},
		{"webm", "video", "video/webm", append([]byte{0x1a, 0x45, 0xdf, 0xa3}, []byte("xxxxxwebmxxxxxxxx")...)},
		{"wav", "audio", "audio/wav", []byte("RIFF\x00\x00\x00\x00WAVE")},
		{"mp3", "audio", "audio/mpeg", []byte("ID3\x04\x00")},
		{"ogg", "audio", "audio/ogg", []byte("OggS\x00")},
		{"svg", "unsupported", "", []byte("<svg onload='alert(1)'/>")},
		{"html", "unsupported", "", []byte("<script>alert(1)</script>")},
		{"fake-png", "unsupported", "", []byte("not really a PNG")},
		{"heic", "unsupported", "", []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00")},
		{"truncated-mp4", "unsupported", "", []byte("\x00\x00\x00\x18ftypisom")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			renderer, mime := BrowserMedia(tc.data)
			if renderer != tc.renderer || mime != tc.mime {
				t.Fatalf("BrowserMedia() = %s / %s; want %s / %s", renderer, mime, tc.renderer, tc.mime)
			}
		})
	}
}

func TestPreviewMediaACLAndByteFidelity(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	video := testMP4()
	// Deliberately misleading MIME: only the blob bytes determine playback type.
	upload, err := s.CommitUpload(ctx, admin, "folder_market", "video.mp4", "text/html", "", bytes.NewReader(video))
	if err != nil {
		t.Fatal(err)
	}
	meta, err := s.Preview(ctx, admin, upload.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Renderer != "video" || meta.MediaType != "video/mp4" || meta.Textual || meta.Sha256 == "" {
		t.Fatalf("unexpected video preview metadata: %+v", meta)
	}
	if _, _, _, err = s.OpenInlinePreview(ctx, member, upload.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unshared media must be forbidden: %v", err)
	}
	share, err := s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "file", ResourceID: upload.FileID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.OpenDownload(ctx, member, upload.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("preview-only share must not grant downloads: %v", err)
	}
	stream, kind, closeReader, err := s.OpenInlinePreview(ctx, member, upload.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if kind != "video" || stream.ContentType != "video/mp4" || stream.Size != int64(len(video)) {
		t.Fatalf("bad stream descriptor: %+v / %s", stream, kind)
	}
	if _, err := stream.Reader.Seek(5, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(stream.Reader)
	closeReader()
	if err != nil || !bytes.Equal(got, video[5:]) {
		t.Fatalf("seeked stream changed bytes: %v", err)
	}
	if err := s.RevokeShare(ctx, admin, share.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = s.OpenInlinePreview(ctx, member, upload.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked preview grant must take immediate effect: %v", err)
	}
}

func TestActiveContentNeverStreamsInline(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	for _, name := range []string{"danger.svg", "spoof.png"} {
		upload, err := s.CommitUpload(ctx, admin, "folder_market", name, "image/png", "", bytes.NewBufferString("<svg onload='alert(1)'/>"))
		if err != nil {
			t.Fatal(err)
		}
		info, err := s.Preview(ctx, admin, upload.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if info.Renderer == "image" {
			t.Fatalf("active bytes should not be rendered inline: %+v", info)
		}
		if _, _, _, err = s.OpenInlinePreview(ctx, admin, upload.FileID); !errors.Is(err, ErrPreviewUnsupported) {
			t.Fatalf("active bytes must be rejected by stream: %v", err)
		}
	}
}
