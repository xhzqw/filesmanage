package application

import (
	"context"
	"filesmanage/internal/domain"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

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
	if support.Class == "native" {
		if err = tx.MarkDerivativeNative(ctx, derivative.ID, version.Sha256); err != nil {
			return domain.ModelDerivative{}, err
		}
		derivative.State = "ready"
		return derivative, tx.Commit(ctx)
	}
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
