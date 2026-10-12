package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const compareMaxBytes int64 = 256 << 10
const compareMaxLines = 350

var errUnsupportedOfficeParts = errors.New("unsupported office package layout")

type CompareLine struct {
	Kind  string `json:"kind"`
	Left  *int   `json:"left,omitempty"`
	Right *int   `json:"right,omitempty"`
	Text  string `json:"text"`
}
type CompareVersionInfo struct {
	Seq    int    `json:"seq"`
	Sha256 string `json:"sha256"`
	Size   int64  `json:"sizeBytes"`
}
type VersionComparison struct {
	Left            CompareVersionInfo `json:"left"`
	Right           CompareVersionInfo `json:"right"`
	Mode            string             `json:"mode"`
	Detail          string             `json:"detail,omitempty"`
	SemanticChanges []SemanticChange   `json:"semanticChanges,omitempty"`
	Lines           []CompareLine      `json:"lines"`
	Added           int                `json:"added"`
	Removed         int                `json:"removed"`
}

// CompareVersions does not provide raw historical bytes. It requires preview
// permission, loads two immutable versions, and computes a bounded text diff.
// Binary, invalid UTF-8, oversized or huge line-count versions show only hashes.
func (s *Service) CompareVersions(ctx context.Context, u domain.User, fileID string, leftSeq, rightSeq int) (VersionComparison, error) {
	out := VersionComparison{Mode: "metadata", Lines: []CompareLine{}}
	if leftSeq < 1 || rightSeq < 1 || leftSeq == rightSeq {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return out, err
	}
	left, err := tx.VersionBySeq(ctx, fileID, leftSeq)
	if err != nil {
		return out, domain.ErrNotFound
	}
	right, err := tx.VersionBySeq(ctx, fileID, rightSeq)
	if err != nil {
		return out, domain.ErrNotFound
	}
	out.Left = CompareVersionInfo{Seq: left.Seq, Sha256: left.Sha256, Size: left.SizeBytes}
	out.Right = CompareVersionInfo{Seq: right.Seq, Sha256: right.Sha256, Size: right.SizeBytes}
	return s.compareBlobs(ctx, tx, file, left.BlobID, right.BlobID, out)
}

// compareBlobs is the same bounded algorithm for committed versions and a
// pending immutable approval payload. Neither path publishes staged content.
func (s *Service) compareBlobs(ctx context.Context, tx ports.Repository, file domain.File, leftBlobID,rightBlobID string, out VersionComparison) (VersionComparison,error) {
	if out.Left.Sha256 == out.Right.Sha256 {
		out.Mode = "identical"
		return out, nil
	}
	office := looksOfficePackage(file.Name)
	if !office && !looksTextual(file.Name, file.ContentType) {
		return out, nil
	}
	maxBytes := compareMaxBytes
	if office {
		maxBytes = compareMaxOfficeArchiveBytes
		out.Detail = "office_parts"
	}
	if out.Left.Size > maxBytes || out.Right.Size > maxBytes {
		out.Mode = "large"
		return out, nil
	}
	read := func(blobID string) (string, string, error) {
		blob, err := tx.BlobByID(ctx, blobID)
		if err != nil {
			return "", "", err
		}
		reader, err := s.blobs.Open(blob.StorageKey)
		if err != nil {
			return "", "", err
		}
		defer reader.Close()
		data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
		if err != nil {
			return "", "", err
		}
		if int64(len(data)) > maxBytes {
			return "", "", domain.ErrInvalidInput
		}
		if office {
			parts, ok := OfficePartLines(data)
			if !ok {
				return "", "", errUnsupportedOfficeParts
			}
			semantic, valid := OfficeSemanticLines(data, file.Name)
			if valid {
				return strings.Join(parts, "\n"), strings.Join(semantic, "\n"), nil
			}
			return strings.Join(parts, "\n"), "", nil
		}
		if !utf8.Valid(data) {
			return "", "", domain.ErrInvalidInput
		}
		return strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\r", "\n"), "", nil
	}
	a, semanticA, err := read(leftBlobID)
	if errors.Is(err, errUnsupportedOfficeParts) {
		out.Detail = ""
		return out, nil
	}
	if err != nil {
		return out, err
	}
	b, semanticB, err := read(rightBlobID)
	if errors.Is(err, errUnsupportedOfficeParts) {
		out.Detail = ""
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if office && semanticA != "" && semanticB != "" {
		if changes, ok := OfficeSemanticChanges(strings.Split(semanticA, "\n"), strings.Split(semanticB, "\n"), strings.ToLower(filepath.Ext(file.Name))); ok {
			a = semanticA
			b = semanticB
			out.Detail = "office_semantic"
			out.SemanticChanges = changes
		}
	}
	aa := strings.Split(a, "\n")
	bb := strings.Split(b, "\n")
	if len(aa) > compareMaxLines || len(bb) > compareMaxLines {
		out.Mode = "large"
		return out, nil
	}
	out.Mode = "text"
	// Dynamic programming LCS is bounded at 350x350 cells to protect CPU.
	dp := make([][]uint16, len(aa)+1)
	for i := range dp {
		dp[i] = make([]uint16, len(bb)+1)
	}
	for i := len(aa) - 1; i >= 0; i-- {
		for j := len(bb) - 1; j >= 0; j-- {
			if aa[i] == bb[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	i, j := 0, 0
	for i < len(aa) || j < len(bb) {
		if i < len(aa) && j < len(bb) && aa[i] == bb[j] {
			li, rj := i+1, j+1
			out.Lines = append(out.Lines, CompareLine{Kind: "equal", Left: &li, Right: &rj, Text: aa[i]})
			i++
			j++
			continue
		}
		if j < len(bb) && (i == len(aa) || dp[i][j+1] >= dp[i+1][j]) {
			rj := j + 1
			out.Lines = append(out.Lines, CompareLine{Kind: "added", Right: &rj, Text: bb[j]})
			out.Added++
			j++
		} else {
			li := i + 1
			out.Lines = append(out.Lines, CompareLine{Kind: "removed", Left: &li, Text: aa[i]})
			out.Removed++
			i++
		}
	}
	return out, nil
}
// CompareApprovalDraft compares the immutable requested payload against the
// recorded base version, never whatever happens to be current now.
func (s *Service) CompareApprovalDraft(ctx context.Context, actor domain.User, id string) (VersionComparison,error) {
 out:=VersionComparison{Mode:"metadata",Lines:[]CompareLine{}}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return out,err};defer tx.Rollback(ctx)
 approval,file,err:=s.authorizedApprovalDraft(ctx,tx,actor,id)
 if err!=nil{return out,err}
 if _,err=s.visibleFile(ctx,tx,actor,approval.FileID,domain.ActionPreview);err!=nil{return out,err}
 base,err:=tx.VersionBySeq(ctx,approval.FileID,approval.BaseSeq)
 if err!=nil{return out,domain.ErrNotFound}
 draft,err:=tx.BlobByID(ctx,approval.PayloadBlobID)
 if err!=nil{return out,domain.ErrNotFound}
 out.Left=CompareVersionInfo{Seq:base.Seq,Sha256:base.Sha256,Size:base.SizeBytes}
 out.Right=CompareVersionInfo{Seq:0,Sha256:draft.Sha256,Size:draft.SizeBytes}
 return s.compareBlobs(ctx,tx,file,base.BlobID,approval.PayloadBlobID,out)
}
