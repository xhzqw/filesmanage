#!/usr/bin/env python3
"""Trace particle trajectories from the original, approved transparent logo.

Standard-library only. Regenerate after changing favicon-48.png; do not redraw
the mark or substitute a mathematical curve unrelated to its geometry.
"""
from collections import defaultdict
from pathlib import Path
import struct
import zlib

root = Path(__file__).resolve().parents[1]
png = (root / "web/public/assets/brand/favicon-48.png").read_bytes()
assert png.startswith(b"\x89PNG\r\n\x1a\n")
pos, compressed = 8, b""
while pos < len(png):
    size = struct.unpack_from(">I", png, pos)[0]
    kind = png[pos + 4:pos + 8]
    payload = png[pos + 8:pos + 8 + size]
    pos += size + 12
    if kind == b"IHDR":
        width, height, depth, color, *_ = struct.unpack(">IIBBBBB", payload)
        assert (width, height, depth, color) == (48, 48, 8, 6)
    elif kind == b"IDAT":
        compressed += payload
    elif kind == b"IEND":
        break

data = zlib.decompress(compressed)
prior = bytearray(width * 4)
filled = set()
cursor = 0
for y in range(height):
    filter_kind = data[cursor]
    cursor += 1
    row = bytearray(data[cursor:cursor + width * 4])
    cursor += width * 4
    for i, value in enumerate(row):
        left = row[i - 4] if i >= 4 else 0
        above = prior[i]
        upper_left = prior[i - 4] if i >= 4 else 0
        if filter_kind == 0:
            predictor = 0
        elif filter_kind == 1:
            predictor = left
        elif filter_kind == 2:
            predictor = above
        elif filter_kind == 3:
            predictor = (left + above) // 2
        elif filter_kind == 4:
            p = left + above - upper_left
            distances = [abs(p - k) for k in (left, above, upper_left)]
            predictor = (left, above, upper_left)[distances.index(min(distances))]
        else:
            raise ValueError("Unsupported PNG filter")
        row[i] = (value + predictor) & 255
    for x in range(width):
        if row[x * 4 + 3] >= 80:
            filled.add((x, y))
    prior = row

# Clockwise boundary segments on the original alpha silhouette.
edges = defaultdict(list)
for x, y in sorted(filled):
    if (x, y - 1) not in filled:
        edges[x, y].append((x + 1, y))
    if (x + 1, y) not in filled:
        edges[x + 1, y].append((x + 1, y + 1))
    if (x, y + 1) not in filled:
        edges[x + 1, y + 1].append((x, y + 1))
    if (x - 1, y) not in filled:
        edges[x, y + 1].append((x, y))

outlines = []
while edges:
    start = next(iter(edges))
    current, contour = start, [start]
    while True:
        nxt = edges[current].pop()
        if not edges[current]:
            del edges[current]
        if nxt == start:
            break
        contour.append(nxt)
        current = nxt
    area = sum(x * contour[(i + 1) % len(contour)][1]
               - contour[(i + 1) % len(contour)][0] * y
               for i, (x, y) in enumerate(contour)) / 2
    # Only outer perimeters. Tiny antialias fragments and interior holes
    # must not become standalone animated loops.
    if area < 9:
        continue
    simplified = [
        point for i, point in enumerate(contour)
        if (point[0] - contour[i - 1][0], point[1] - contour[i - 1][1])
        != (contour[(i + 1) % len(contour)][0] - point[0],
            contour[(i + 1) % len(contour)][1] - point[1])
    ]
    outlines.append((area, "M" + " L".join(f"{x} {y}" for x, y in simplified) + " Z"))

outlines.sort(reverse=True)
assert len(outlines) >= 1, "The logo has no traceable ink"
dest = root / "web/src/shared/ui/brandLoaderPaths.ts"
paths = ",\n".join("  " + repr(path) for _, path in outlines[:6])
dest.write_text("// Generated from the official brand favicon. Run scripts/generate_brand_loader_paths.py.\n"
                "export const brandLoaderPaths = [\n" + paths + "\n] as const;\n")
print(f"Wrote {min(len(outlines), 6)} approved-logo outer contours: "
      + ", ".join(str(round(a)) for a, _ in outlines[:6]))
