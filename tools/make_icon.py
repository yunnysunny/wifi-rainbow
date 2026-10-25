"""生成 Tauri 需要的图标（零依赖，只用标准库）。

生成 64x64 的简易渐变图标：深色底 + 三道越来越强的信号弧。
输出 src-tauri/icons/icon.ico 与 icon.png。
"""
from __future__ import annotations

import math
import os
import struct
import zlib

SIZE = 64


def render() -> list[list[tuple[int, int, int, int]]]:
    px = [[(0, 0, 0, 0) for _ in range(SIZE)] for _ in range(SIZE)]
    cx, cy = SIZE / 2, SIZE * 0.72
    for y in range(SIZE):
        for x in range(SIZE):
            t = y / SIZE
            base = (int(18 + 22 * t), int(22 + 26 * t), int(32 + 34 * t), 255)
            px[y][x] = base
    colors = [(96, 200, 255, 255), (120, 255, 200, 255), (255, 214, 102, 255)]
    radii = [26.0, 20.0, 14.0]
    for i, r in enumerate(radii):
        for ang_steps in range(720):
            a = math.pi + (math.pi * ang_steps / 719)
            for w in range(3):
                for rr in (r, r - 1.0, r - 2.0):
                    x = int(round(cx + math.cos(a) * rr))
                    y = int(round(cy + math.sin(a) * rr))
                    if 0 <= x < SIZE and 0 <= y < SIZE:
                        px[y][x] = colors[i]
    return px


def to_bgra_rows(px):
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            r, g, b, a = px[y][x]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    return rows


def write_ico(path, px):
    rows = list(reversed(to_bgra_rows(px)))  # bottom-up
    xor = b"".join(rows)
    mask_row = ((SIZE + 31) // 32) * 4
    and_mask = b"\x00" * (mask_row * SIZE)
    dib = struct.pack("<IiiHHIIiiII", 40, SIZE, SIZE * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    image = dib + xor + and_mask
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(image), 22)
    with open(path, "wb") as f:
        f.write(header + entry + image)


def write_png(path, px):
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            r, g, b, a = px[y][x]
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rust", "src-tauri", "icons")
    os.makedirs(out, exist_ok=True)
    px = render()
    write_ico(os.path.join(out, "icon.ico"), px)
    write_png(os.path.join(out, "icon.png"), px)
    print("icons ->", os.path.abspath(out))


if __name__ == "__main__":
    main()
