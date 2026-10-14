#!/usr/bin/env python3
"""Fail-closed static import boundaries for Go and React.

Go code uses package-family deny rules; TS uses resolved relative dependencies.
This supplements, but does not replace, runtime authorization and SQL review.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "web" / "src"
RANK = {"shared": 0, "entities": 1, "features": 2, "pages": 3, "app": 4}
GO_BLOCKED = {
    "internal/domain": (
        "github.com/gin-gonic/gin", "github.com/jackc/pgx",
        "filesmanage/internal/httpx", "filesmanage/internal/adapter",
        "filesmanage/internal/application", "filesmanage/internal/ports",
    ),
    "internal/ports": (
        "github.com/gin-gonic/gin", "github.com/jackc/pgx",
        "filesmanage/internal/httpx", "filesmanage/internal/adapter",
        "filesmanage/internal/application",
    ),
    "internal/application": (
        "github.com/gin-gonic/gin", "github.com/jackc/pgx",
        "filesmanage/internal/httpx", "filesmanage/internal/adapter",
    ),
    "internal/httpx": ("github.com/jackc/pgx", "filesmanage/internal/adapter"),
    "internal/adapter/postgres": ("filesmanage/internal/httpx",),
}
GO_IMPORT = re.compile(r'^\s*(?:[a-zA-Z_][\w]*\s+)?["\']([^"\']+)["\']\s*$', re.M)
TS_IMPORT = re.compile(r'\bfrom\s*["\']([^"\']+)["\']|\bimport\s*\(\s*["\']([^"\']+)["\']\s*\)')
violations = []


def ts_allowed(src_path: Path, target_path: Path) -> bool:
    if src_path == SRC / "main.tsx":
        return target_path.is_relative_to(SRC / "app")
    src_parts = src_path.relative_to(SRC).parts
    target_parts = target_path.relative_to(SRC).parts
    src_layer, dst_layer = src_parts[0], target_parts[0]
    if src_layer not in RANK or dst_layer not in RANK:
        return src_layer == dst_layer
    if src_layer == dst_layer:
        if src_layer in {"features", "entities"} and len(src_parts) > 1 and len(target_parts) > 1:
            return src_parts[1] == target_parts[1]
        return True
    return RANK[dst_layer] < RANK[src_layer]


def test_checker() -> None:
    # These assertions must hold even on a healthy repository.
    assert not ts_allowed(SRC / "shared" / "api.ts", SRC / "pages" / "Home.tsx")
    assert not ts_allowed(SRC / "features" / "a" / "use.ts", SRC / "features" / "b" / "api.ts")
    assert not ts_allowed(SRC / "entities" / "file" / "types.ts", SRC / "app" / "router.tsx")
    assert ts_allowed(SRC / "pages" / "Home.tsx", SRC / "features" / "folder" / "api.ts")
    assert ts_allowed(SRC / "features" / "folder" / "api.ts", SRC / "shared" / "http.ts")


def main() -> int:
    test_checker()
    go_count = 0
    for directory, forbidden in GO_BLOCKED.items():
        for file in (ROOT / directory).rglob("*.go"):
            go_count += 1
            for item in GO_IMPORT.findall(file.read_text(encoding="utf8")):
                if any(item.startswith(prefix) for prefix in forbidden):
                    violations.append(f"{file.relative_to(ROOT)} imports forbidden {item}")

    ts_count = 0
    for file in SRC.rglob("*"):
        if file.suffix not in {".ts", ".tsx"}:
            continue
        ts_count += 1
        for match in TS_IMPORT.finditer(file.read_text(encoding="utf8")):
            name = match.group(1) or match.group(2)
            if not name.startswith("."):
                continue
            target = (file.parent / name).resolve()
            if not target.is_relative_to(SRC):
                violations.append(f"{file.relative_to(ROOT)} import escapes src: {name}")
            elif not ts_allowed(file, target):
                violations.append(f"{file.relative_to(ROOT)} violates layer dependency: {name}")

    if violations:
        print("ARCHITECTURE FAIL:")
        for issue in violations:
            print(" -", issue)
        return 1
    print(f"ARCHITECTURE PASS: {go_count} Go files and {ts_count} TS modules; negative rule self-tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
