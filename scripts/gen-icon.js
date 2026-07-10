// DevCLI app icon → 1024x1024 PNG (no image deps; hand-rolled PNG).
// Dark navy squircle + teal→blue terminal prompt "❯ ▬" + a shiny top rim.
// Run: node scripts/gen-icon.js
import zlib from "node:zlib";
import fs from "node:fs";

const W = 1024, H = 1024;
const buf = Buffer.alloc(W * H * 4);
const setA = (x, y, r, g, b, a) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4, ia = a / 255, ib = 1 - ia;
  buf[o] = r * ia + buf[o] * ib;
  buf[o + 1] = g * ia + buf[o + 1] * ib;
  buf[o + 2] = b * ia + buf[o + 2] * ib;
  buf[o + 3] = Math.max(buf[o + 3], a);
};
const lerp = (a, b, t) => a + (b - a) * t;

// dark rounded-squircle background + shiny top rim
const R = 232;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = Math.max(R - x, x - (W - R), 0);
    const dy = Math.max(R - y, y - (H - R), 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    const edge = R - d;
    if (edge <= -1.5) continue;
    const aa = Math.max(0, Math.min(1, edge + 0.5));
    const t = (x + y) / (W + H);          // deep navy diagonal
    const r = lerp(13, 26, t);            // #0D1117 -> #1A2230
    const g = lerp(17, 34, t);
    const b = lerp(23, 48, t);
    setA(x, y, r, g, b, 255 * aa);
    // subtle shiny top rim
    if (edge > 0 && edge < 12) {
      const rim = 1 - edge / 12;
      const top = 0.35 + 0.65 * (1 - y / H);
      setA(x, y, 235, 245, 255, 100 * rim * rim * top * aa);
    }
    // two-layer border: outer teal ring + inner blue ring, with a dark gap
    if (edge >= 1 && edge < 11) {
      const near = 1 - Math.abs(edge - 6) / 5.5;
      setA(x, y, 120, 235, 224, 250 * Math.max(0, near) * aa); // outer (teal)
    }
    if (edge >= 18 && edge < 28) {
      const near = 1 - Math.abs(edge - 23) / 5.5;
      setA(x, y, 88, 166, 255, 180 * Math.max(0, near) * aa); // inner (blue)
    }
  }
}

const TEAL = [45, 212, 191], BLUE = [88, 166, 255];
// gradient round-capped stroke (teal -> blue along its length)
function stroke(x0, y0, x1, y1, width, c0, c1) {
  const len = Math.hypot(x1 - x0, y1 - y0), steps = Math.ceil(len), rad = width / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, cx = lerp(x0, x1, t), cy = lerp(y0, y1, t);
    const cr = lerp(c0[0], c1[0], t), cg = lerp(c0[1], c1[1], t), cb = lerp(c0[2], c1[2], t);
    for (let oy = -rad; oy <= rad; oy++)
      for (let ox = -rad; ox <= rad; ox++) {
        const dd = Math.hypot(ox, oy);
        if (dd <= rad + 0.5) setA(cx + ox, cy + oy, cr, cg, cb, 255 * Math.max(0, Math.min(1, rad + 0.5 - dd)));
      }
  }
}

// prompt chevron ❯ + cursor bar
const cy = 512, wPix = 74;
stroke(378, 512 - 150, 486, 512, wPix, TEAL, BLUE);
stroke(486, 512, 378, 512 + 150, wPix, BLUE, TEAL);

const bx = 560, bw = 190, bh = 96, br = 26;
for (let y = cy - bh / 2; y <= cy + bh / 2; y++)
  for (let x = bx; x <= bx + bw; x++) {
    const dx = Math.max(bx + br - x, x - (bx + bw - br), 0);
    const dy = Math.max(cy - bh / 2 + br - y, y - (cy + bh / 2 - br), 0);
    const dd = Math.sqrt(dx * dx + dy * dy);
    const tt = (x - bx) / bw;
    if (dd <= br + 0.5) setA(x, y, lerp(TEAL[0], BLUE[0], tt), lerp(TEAL[1], BLUE[1], tt), lerp(TEAL[2], BLUE[2], tt), 255 * Math.max(0, Math.min(1, br + 0.5 - dd)));
  }

// encode PNG
const raw = Buffer.alloc((W * 4 + 1) * H);
let o = 0;
for (let y = 0; y < H; y++) { raw[o++] = 0; buf.copy(raw, o, y * W * 4, y * W * 4 + W * 4); o += W * 4; }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(new URL("../icon-src.png", import.meta.url), png);
console.log("wrote icon-src.png", png.length, "bytes");
