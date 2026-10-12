#!/usr/bin/env python3
"""Fail builds if the shared loader regresses to a favicon-sized/opaque mark."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
asset = ROOT / "web/public/assets/brand/logo-loader-256.png"
source = asset.read_bytes()
assert source.startswith(b"\x89PNG\r\n\x1a\n"), "Loader mark must be a PNG"
pos, image = 8, bytearray()
width = height = depth = color = None
while pos < len(source):
    length = struct.unpack_from(">I", source, pos)[0]
    kind = source[pos + 4:pos + 8]
    data = source[pos + 8:pos + 8 + length]
    pos += 12 + length
    if kind == b"IHDR":
        width, height, depth, color, *_ = struct.unpack(">IIBBBBB", data)
    elif kind == b"IDAT":
        image.extend(data)
    elif kind == b"IEND":
        break
assert (width, height, depth, color) == (256, 256, 8, 6), "Loader mark must be 256px RGBA"

# favicon_alpha.py outputs filter-zero image scanlines before PNG compression.
pixels = zlib.decompress(image)
stride = width * 4 + 1
assert len(pixels) == height * stride
assert all(pixels[y * stride] == 0 for y in range(height)), "Unexpected PNG scanline filter"

def alpha(x: int, y: int) -> int:
    return pixels[y * stride + 1 + x * 4 + 3]

for corner in ((0, 0), (0, 255), (255, 0), (255, 255), (128, 0), (0, 128)):
    assert alpha(*corner) == 0, "Loader asset has an opaque matte or white block"
visible = sum(alpha(x, y) > 200 for y in range(height) for x in range(width))
assert 4000 < visible < 23000, f"Implausible logo silhouette: {visible} ink pixels"
component = (ROOT / "web/src/shared/ui/BrandLoader.tsx").read_text()
style = (ROOT / "web/src/shared/ui/brand-loader.css").read_text()
assert "logo-loader-256.png" in component and "logo-loader-256.png" in style
assert "brandLoaderPaths" not in component and "favicon-48.png" not in style
print(f"BRAND_LOADER_ASSET_PASS: full-resolution transparent logo ({visible} ink pixels)")
