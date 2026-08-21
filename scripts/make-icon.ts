// 生成 1024×1024 图标源（无外部依赖：手写 PNG chunk）→ dist/app-icon.png。
// 之后 `bunx tauri icon dist/app-icon.png`（apps/shell）派生 icns/ico 全套到 src-tauri/icons。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const S = 1024;
const px = Buffer.alloc(S * S * 4);
const cx = S / 2;
const cy = S / 2;
const r = S * 0.42;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const d = Math.hypot(x - cx, y - cy);
    const inside = d <= r;
    const ring = d > r - 90; // 浅色外环 + 深底
    const [R, G, B] = inside ? (ring ? [96, 165, 250] : [23, 27, 35]) : [0, 0, 0];
    px[i] = R;
    px[i + 1] = G;
    px[i + 2] = B;
    px[i + 3] = inside ? 255 : 0;
  }
}

const stride = S * 4 + 1; // 每行前置 filter 字节 0
const raw = Buffer.alloc(S * stride);
for (let y = 0; y < S; y++) {
  raw[y * stride] = 0;
  px.copy(raw, y * stride + 1, y * S * 4, (y + 1) * S * 4);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of b) crc = (crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/app-icon.png",
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log("icon source → dist/app-icon.png");
