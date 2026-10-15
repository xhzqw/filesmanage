package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// A DWG has an AC10xx six-byte signature followed by its binary header.
// A short/truncated file (including the eight-byte fake.dwg fixture) can
// never be converted, regardless of queue capacity or converter availability.
const minimumDWGPreviewBytes = 64

func (s *Service) hasValidDWGHeader(ctx context.Context, repo ports.Repository, version domain.FileVersion) (bool, error) {
	if version.SizeBytes < minimumDWGPreviewBytes {
		return false, nil
	}
	blob, err := repo.BlobByID(ctx, version.BlobID)
	if err != nil {
		return false, err
	}
	source, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return false, err
	}
	defer source.Close()
	var header [6]byte
	if _, err = io.ReadFull(source, header[:]); err != nil {
		return false, err
	}
	return string(header[:4]) == "AC10" &&
		header[4] >= '0' && header[4] <= '9' && header[5] >= '0' && header[5] <= '9', nil
}

// CADSupport describes one source format's preview capability class.
type CADSupport struct {
	Format string
	Class  string // native | converted | licensed | unverified
	Engine string
	Note   string
}

// FormatMatrix is the honest capability matrix surfaced by the API and UI.
func FormatMatrix() []CADSupport {
	return []CADSupport{
		{Format: "stl", Class: "native", Engine: "three.js STLLoader", Note: "浏览器直接渲染三角网格"},
		{Format: "obj", Class: "native", Engine: "three.js OBJLoader", Note: "浏览器直接渲染"},
		{Format: "glb", Class: "native", Engine: "three.js GLTFLoader", Note: "浏览器直接渲染"},
		{Format: "gltf", Class: "native", Engine: "three.js GLTFLoader", Note: "浏览器直接渲染"},
		{Format: "step", Class: "converted", Engine: "gmsh (OpenCASCADE)", Note: "服务端 Worker 三角化为 MSH 组件网格后渲染"},
		{Format: "stp", Class: "converted", Engine: "gmsh (OpenCASCADE)", Note: "服务端 Worker 三角化后渲染"},
		{Format: "iges", Class: "converted", Engine: "gmsh (OpenCASCADE)", Note: "服务端 Worker 三角化为 MSH 组件网格后渲染"},
		{Format: "igs", Class: "converted", Engine: "gmsh (OpenCASCADE)", Note: "服务端 Worker 三角化后渲染"},
		{Format: "ply", Class: "native", Engine: "three.js PLYLoader", Note: "浏览器直接渲染点云/网格"},
		{Format: "3mf", Class: "native", Engine: "three.js 3MFLoader", Note: "浏览器直接渲染多部件 3MF"},
		{Format: "dxf", Class: "native", Engine: "内置 DXF 二维渲染器", Note: "浏览器解析二维工程图实体与图层"},
		dwgCADSupport(),
	}
}

// DWG is available only when an executable is installed and usable.
func dwgCADSupport() CADSupport {
	bin := strings.TrimSpace(os.Getenv("FILESMANAGE_DWGREAD"))
	if bin == "" {
		bin = "dwgread"
	}
	if _, err := exec.LookPath(bin); err == nil {
		return CADSupport{Format: "dwg", Class: "converted", Engine: "LibreDWG dwgread", Note: "服务端转为 DXF；专有对象或 SHX 字体可能存在兼容限制"}
	}
	return CADSupport{Format: "dwg", Class: "licensed", Engine: "—", Note: "当前未安装 DWG 转换器"}
}

// RequestDerivative queues a conversion for a file version. Native formats are
// recorded as ready without a conversion job.
func (s *Service) RequestDerivative(ctx context.Context, u domain.User, fileID string) (domain.ModelDerivative, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.ModelDerivative{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return domain.ModelDerivative{}, err
	}
	format := strings.TrimPrefix(strings.ToLower(extensionOf(file.Name)), ".")
	support, ok := cadSupportFor(format)
	if !ok {
		return domain.ModelDerivative{}, domain.ErrInvalidInput
	}
	if support.Class == "licensed" || support.Class == "unverified" {
		return domain.ModelDerivative{}, domain.ErrInvalidInput
	}
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return domain.ModelDerivative{}, domain.ErrNotFound
	}
	if format == "dwg" {
		valid, checkErr := s.hasValidDWGHeader(ctx, tx, version)
		if checkErr != nil {
			return domain.ModelDerivative{}, checkErr
		}
		if !valid {
			return domain.ModelDerivative{}, domain.ErrInvalidInput
		}
	}
	// Converted formats emit MSH 2.2: it keeps shared node indices, which lets
	// the viewer recover the assembly's connected components (parts) from the
	// merged mesh. STL carries no such structure.
	outputKind := "msh"
	if support.Class == "native" {
		outputKind = format
	} else if format == "dwg" {
		outputKind = "dxf"
	}
	derivative, err := tx.EnsureDerivative(ctx, domain.ModelDerivative{
		ID: NewID("deriv"), FileID: file.ID, VersionSeq: version.Seq,
		SourceSha256: version.Sha256, SourceFormat: format, OutputKind: outputKind,
		Converter: support.Engine, ConverterVersion: "1.0",
		SettingsHash: HashToken(format + "|" + outputKind),
	})
	if err != nil {
		return domain.ModelDerivative{}, err
	}
	// An open preview or a duplicate POST is not an instruction to redo an
	// active/finished conversion. Only failed derivatives may be retried.
	if derivative.State == "running" || derivative.State == "ready" {
		return derivative, tx.Commit(ctx)
	}
	if support.Class == "native" {
		if err = tx.MarkDerivativeNative(ctx, derivative.ID, version.Sha256); err != nil {
			return domain.ModelDerivative{}, err
		}
		derivative.State = "ready"
		return derivative, tx.Commit(ctx)
	}
	// The repository uses a derivative-row lock plus an outstanding-job guard,
	// so repeated requests never flood the worker with duplicates.
	if err = tx.EnqueueDerivativeJob(ctx, NewID("job"), derivative.ID); err != nil {
		return domain.ModelDerivative{}, err
	}
	derivative.State = "queued"
	return derivative, tx.Commit(ctx)
}

func cadSupportFor(format string) (CADSupport, bool) {
	for _, s := range FormatMatrix() {
		if s.Format == format {
			return s, true
		}
	}
	return CADSupport{}, false
}

// DerivativeStatus reports the current state of a file's preview asset.
func (s *Service) DerivativeStatus(ctx context.Context, u domain.User, fileID string) (domain.ModelDerivative, CADSupport, bool, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.ModelDerivative{}, CADSupport{}, false, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return domain.ModelDerivative{}, CADSupport{}, false, err
	}
	format := strings.TrimPrefix(strings.ToLower(extensionOf(file.Name)), ".")
	support, ok := cadSupportFor(format)
	if !ok {
		return domain.ModelDerivative{}, CADSupport{}, false, nil
	}
	if format == "dwg" && support.Class == "converted" {
		version, versionErr := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
		if versionErr != nil {
			return domain.ModelDerivative{}, CADSupport{}, false, versionErr
		}
		valid, checkErr := s.hasValidDWGHeader(ctx, tx, version)
		if checkErr != nil {
			return domain.ModelDerivative{}, CADSupport{}, false, checkErr
		}
		if !valid {
			support.Class = "invalid"
			support.Note = "此文件不是完整有效的 DWG 图纸，或文件头已损坏。请重新导出原始 DWG 后上传。"
			return domain.ModelDerivative{}, support, false, nil
		}
	}
	derivative, found, err := tx.DerivativeForFile(ctx, file.ID, currentSeq(file))
	if err != nil || !found {
		return domain.ModelDerivative{}, support, false, nil
	}
	// Previously converted DXF remains previewable after removal of the tool.
	if format == "dwg" && derivative.State == "ready" && derivative.OutputKind == "dxf" && derivative.BlobID != "" {
		support.Class = "converted"
		support.Engine = derivative.Converter
		support.Note = "使用已缓存的 DWG 转 DXF 预览"
	}
	return derivative, support, true, nil
}

// OpenDerivative streams the browser-renderable bytes for a file: the source
// blob for native formats, the converted output once ready.
func (s *Service) OpenDerivative(ctx context.Context, u domain.User, fileID string) (readSeekCloser, string, int64, string, string, func(), error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, "", "", nil, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return nil, "", 0, "", "", nil, err
	}
	format := strings.TrimPrefix(strings.ToLower(extensionOf(file.Name)), ".")
	support, ok := cadSupportFor(format)
	if !ok {
		return nil, "", 0, "", "", nil, domain.ErrInvalidInput
	}
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return nil, "", 0, "", "", nil, domain.ErrNotFound
	}
	if support.Class == "native" {
		blob, err := tx.BlobByID(ctx, version.BlobID)
		if err != nil {
			return nil, "", 0, "", "", nil, domain.ErrNotFound
		}
		reader, err := s.blobs.Open(blob.StorageKey)
		if err != nil {
			return nil, "", 0, "", "", nil, err
		}
		return reader, file.Name, blob.SizeBytes, contentTypeFor(format), blob.Sha256, func() { _ = reader.Close() }, nil
	}
	derivative, found, err := tx.DerivativeForFile(ctx, file.ID, version.Seq)
	if err != nil || !found {
		return nil, "", 0, "", "", nil, domain.ErrNotFound
	}
	if derivative.State != "ready" || derivative.BlobID == "" {
		return nil, "", 0, "", "", nil, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, derivative.BlobID)
	if err != nil {
		return nil, "", 0, "", "", nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return nil, "", 0, "", "", nil, err
	}
	name := strings.TrimSuffix(file.Name, filepath.Ext(file.Name)) + "." + derivative.OutputKind
	return reader, name, blob.SizeBytes, contentTypeFor(derivative.OutputKind), blob.Sha256, func() { _ = reader.Close() }, nil
}

func contentTypeFor(format string) string {
	switch format {
	case "msh":
		return "model/mesh"
	case "stl":
		return "model/stl"
	case "obj":
		return "model/obj"
	case "glb":
		return "model/gltf-binary"
	case "gltf":
		return "model/gltf+json"
	case "dxf":
		return "image/vnd.dxf"
	default:
		return "application/octet-stream"
	}
}

type readSeekCloser = interface {
	Read([]byte) (int, error)
	Seek(int64, int) (int64, error)
	Close() error
}

var _ = time.Now
