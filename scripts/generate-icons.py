#!/usr/bin/env python3
"""Generate solid high-contrast PWA icons with stdlib only (no Pillow)."""
import struct, zlib, os

def write_png(path, size):
    bg = (0, 0, 0)       # black
    fg = (255, 214, 10)  # accent ring
    # radius of centred disc in pixels
    r = size * 0.30
    cx = cy = size / 2
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter byte
        for x in range(size):
            dx, dy = x - cx, y - cy
            d = (dx * dx + dy * dy) ** 0.5
            if abs(d - r) < size * 0.045:
                px = fg
            elif d < r:
                px = (17, 17, 17)
            else:
                px = bg
            raw.extend(px)
    comp = zlib.compress(bytes(raw), 9)
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return c
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({len(png)} bytes)")

base = os.path.join(os.path.dirname(__file__), "..", "icons")
write_png(os.path.join(base, "icon-192.png"), 192)
write_png(os.path.join(base, "icon-512.png"), 512)
