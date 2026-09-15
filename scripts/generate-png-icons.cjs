const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimal pure-node PNG encoder
function createPNG(width, height, getPixel) {
  // Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 6; // Color type: RGBA (6)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdr = makeChunk('IHDR', ihdrData);

  // Raw image scanlines
  // Each scanline begins with filter type byte (0 = None)
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // filter byte None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height);
      const pixelOffset = rowOffset + 1 + x * 4;
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  const crc = crc32(buf.subarray(4, 8 + len));
  buf.writeInt32BE(crc, 8 + len);
  return buf;
}

// Standard CRC32
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

// Design: Dark institutional terminal background with cyan/emerald geometric lattice & candle
function pixelShader(x, y, w, h, isMaskable = false) {
  const nx = (x / w) * 2 - 1; // -1 to 1
  const ny = (y / h) * 2 - 1; // -1 to 1
  const dist = Math.hypot(nx, ny);

  // Background
  let r = 9, g = 9, b = 11, a = 255;

  // Maskable mode has safe margin (80% circle)
  const scale = isMaskable ? 0.75 : 0.88;
  const sx = nx / scale;
  const sy = ny / scale;
  const sDist = Math.hypot(sx, sy);

  // Subtle radial gradient
  const bgGrad = Math.max(0, 1 - dist * 0.7);
  r = Math.floor(9 + bgGrad * 12);
  g = Math.floor(9 + bgGrad * 18);
  b = Math.floor(15 + bgGrad * 35);

  // Outer ring / hex
  if (sDist >= 0.75 && sDist <= 0.82) {
    return [56, 189, 248, 255]; // cyan-400
  }

  // Candlestick 1 (left green)
  if (sx >= -0.35 && sx <= -0.22 && sy >= -0.15 && sy <= 0.25) {
    return [16, 185, 129, 255]; // emerald-500
  }
  if (Math.abs(sx - -0.285) <= 0.015 && sy >= -0.35 && sy <= 0.4) {
    return [52, 211, 153, 255]; // emerald-400 wick
  }

  // Candlestick 2 (center cyan)
  if (sx >= -0.07 && sx <= 0.07 && sy >= -0.05 && sy <= 0.3) {
    return [14, 165, 233, 255]; // sky-500
  }
  if (Math.abs(sx) <= 0.015 && sy >= -0.25 && sy <= 0.45) {
    return [56, 189, 248, 255]; // sky-400 wick
  }

  // Candlestick 3 (right breakout green)
  if (sx >= 0.22 && sx <= 0.38 && sy >= -0.45 && sy <= 0.0) {
    return [16, 185, 129, 255]; // emerald-500
  }
  if (Math.abs(sx - 0.3) <= 0.015 && sy >= -0.65 && sy <= 0.2) {
    return [52, 211, 153, 255]; // emerald-400 wick
  }

  // Dynamic rising trendline
  // line from (-0.5, 0.3) to (0.5, -0.4)
  // equation: sy - 0.3 = -0.7 * (sx + 0.5) => sy + 0.7*sx - (-0.05) = 0
  const lineDist = Math.abs(sy + 0.7 * sx + 0.05) / Math.hypot(1, 0.7);
  if (lineDist < 0.025 && sx >= -0.55 && sx <= 0.55) {
    return [52, 211, 153, 255]; // emerald line
  }

  return [r, g, b, a];
}

const publicDir = path.resolve(__dirname, '../public');

// 1. pwa-192x192.png
fs.writeFileSync(
  path.join(publicDir, 'pwa-192x192.png'),
  createPNG(192, 192, (x, y, w, h) => pixelShader(x, y, w, h, false))
);
console.log('Created pwa-192x192.png');

// 2. pwa-512x512.png
fs.writeFileSync(
  path.join(publicDir, 'pwa-512x512.png'),
  createPNG(512, 512, (x, y, w, h) => pixelShader(x, y, w, h, false))
);
console.log('Created pwa-512x512.png');

// 3. pwa-maskable-512x512.png
fs.writeFileSync(
  path.join(publicDir, 'pwa-maskable-512x512.png'),
  createPNG(512, 512, (x, y, w, h) => pixelShader(x, y, w, h, true))
);
console.log('Created pwa-maskable-512x512.png');

// 4. apple-touch-icon.png (180x180)
fs.writeFileSync(
  path.join(publicDir, 'apple-touch-icon.png'),
  createPNG(180, 180, (x, y, w, h) => pixelShader(x, y, w, h, false))
);
console.log('Created apple-touch-icon.png');
