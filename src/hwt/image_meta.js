/**
 * Pure-JS binary dimension parser for PNG, JPEG, WebP, GIF, and MP4,
 * plus Huawei Lockscreen asset path resolution (src, srcid, srcExp, ImageNumber/ImageSeries).
 */

export function parsePngDimensions(buf) {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
}

export function parseGifDimensions(buf) {
  if (buf.length < 10) return null;
  const hdr = buf.subarray(0, 6).toString('ascii');
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
}

export function parseJpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) break;
    const marker = buf[pos++];
    // Standalone markers (TEM, RST0..RST7, SOI, EOI)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break;
      continue;
    }
    if (pos + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > buf.length) break;

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (pos + 7 <= buf.length) {
        const height = buf.readUInt16BE(pos + 3);
        const width = buf.readUInt16BE(pos + 5);
        return { width, height, format: 'jpeg' };
      }
    }
    pos += segLen;
  }
  return null;
}

export function parseWebpDimensions(buf) {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return null;
  }
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // Lossy VP8: frame tag 3 bytes, start code 0x9d 0x01 0x2a at offset 23
    if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, format: 'webp' };
    }
  } else if (chunk === 'VP8L' && buf.length >= 25) {
    if (buf[20] === 0x2f) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, format: 'webp' };
    }
  } else if (chunk === 'VP8X' && buf.length >= 30) {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, format: 'webp' };
  }
  return null;
}

export function parseMp4Dimensions(buf) {
  // Walk top-level boxes -> moov -> trak -> tkhd (extracts largest non-zero width/height)
  const containerTypes = new Set(['moov', 'trak']);
  let best = null;

  function walk(start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = buf.readUInt32BE(pos);
      const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
      let hdr = 8;
      if (size === 1 && pos + 16 <= end) {
        size = Number(buf.readBigUInt64BE(pos + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdr || pos + size > end) break;

      if (type === 'tkhd') {
        const version = buf[pos + hdr];
        const widthOff = pos + hdr + (version === 1 ? 88 : 76);
        if (widthOff + 8 <= pos + size) {
          const w = buf.readUInt32BE(widthOff) >>> 16;
          const h = buf.readUInt32BE(widthOff + 4) >>> 16;
          if (w > 0 && h > 0) {
            if (!best || w * h > best.width * best.height) {
              best = { width: w, height: h, format: 'mp4' };
            }
          }
        }
      } else if (containerTypes.has(type)) {
        walk(pos + hdr, pos + size);
      }
      pos += size;
    }
  }

  walk(0, buf.length);
  return best;
}

export function parseMediaDimensions(buf, filename = '') {
  if (!buf || buf.length < 10) return null;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp4') || lower.endsWith('.mov')) {
    return parseMp4Dimensions(buf);
  }
  return (
    parsePngDimensions(buf) ||
    parseJpegDimensions(buf) ||
    parseWebpDimensions(buf) ||
    parseGifDimensions(buf) ||
    parseMp4Dimensions(buf)
  );
}

export class AssetIndex {
  constructor(archive, basePrefix = 'unlock/lockscreen/') {
    this.archive = archive;
    this.basePrefix = basePrefix;
    this.dimCache = new Map();
    this.relToEntry = new Map();
    this.lowerToRel = new Map();

    for (const entry of archive.entries) {
      if (entry.isDirectory || !entry.name.startsWith(basePrefix)) continue;
      const rel = entry.name.slice(basePrefix.length);
      this.relToEntry.set(rel, entry);
      this.lowerToRel.set(rel.toLowerCase(), rel);
    }
  }

  resolveRel(relPath) {
    if (!relPath) return null;
    const cleaned = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (this.relToEntry.has(cleaned)) return cleaned;
    const low = cleaned.toLowerCase();
    if (this.lowerToRel.has(low)) return this.lowerToRel.get(low);
    return null;
  }

  getDimensions(relPath) {
    const resolved = this.resolveRel(relPath);
    if (!resolved) return null;
    if (this.dimCache.has(resolved)) return this.dimCache.get(resolved);
    const entry = this.relToEntry.get(resolved);
    let dims = null;
    try {
      const buf = this.archive.readBuffer(entry);
      dims = parseMediaDimensions(buf, resolved);
    } catch {
      dims = null;
    }
    this.dimCache.set(resolved, dims);
    return dims;
  }

  /**
   * Resolve image path using src, optional srcid, or srcExp evaluation.
   * Huawei pattern: `src="foo.png" srcid="3"` -> `foo_3.png` (or `foo3.png`).
   */
  resolveImageAsset({ src, srcid, srcExpVal }) {
    if (srcExpVal && typeof srcExpVal === 'string') {
      const direct = this.resolveRel(srcExpVal);
      if (direct) return direct;
    }
    if (!src) return null;

    if (srcid !== undefined && srcid !== null && srcid !== '') {
      const idStr = Number.isFinite(Number(srcid)) ? String(Math.trunc(Number(srcid))) : String(srcid);
      const dot = src.lastIndexOf('.');
      const stem = dot >= 0 ? src.slice(0, dot) : src;
      const ext = dot >= 0 ? src.slice(dot) : '';
      const candidates = [
        `${stem}_${idStr}${ext}`,
        `${stem}${idStr}${ext}`,
        `${stem}_0${ext}`,
        `${stem}0${ext}`,
        `${stem}_1${ext}`,
        src,
      ];
      for (const c of candidates) {
        const r = this.resolveRel(c);
        if (r) return r;
      }
      // Prefix fallback for arbitrary first matching variant
      const prefixLow = `${stem}_`.toLowerCase();
      for (const [low, rel] of this.lowerToRel.entries()) {
        if (low.startsWith(prefixLow) && low.endsWith(ext.toLowerCase())) {
          return rel;
        }
      }
    }

    const direct = this.resolveRel(src);
    if (direct) return direct;

    // Last resort: stem_0.ext or stem_1.ext when src itself is a template name
    const dot = src.lastIndexOf('.');
    if (dot >= 0) {
      const stem = src.slice(0, dot);
      const ext = src.slice(dot);
      for (const suffix of ['_0', '0', '_1', '1']) {
        const r = this.resolveRel(`${stem}${suffix}${ext}`);
        if (r) return r;
      }
      const prefixLow = `${stem}_`.toLowerCase();
      for (const [low, rel] of this.lowerToRel.entries()) {
        if (low.startsWith(prefixLow) && low.endsWith(ext.toLowerCase())) {
          return rel;
        }
      }
    }
    return null;
  }

  /**
   * Find largest media asset in unlock/lockscreen/ for design canvas inference.
   */
  findLargestMedia() {
    const candidates = [];
    for (const [rel, entry] of this.relToEntry.entries()) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(rel)) continue;
      if (entry.uncompressedSize < 20000) continue;
      candidates.push({ rel, size: entry.uncompressedSize });
    }
    candidates.sort((a, b) => b.size - a.size);
    let largest = null;
    for (const c of candidates.slice(0, 12)) {
      const dims = this.getDimensions(c.rel);
      if (!dims) continue;
      if (!largest || dims.width * dims.height > largest.width * largest.height) {
        largest = { rel: c.rel, ...dims };
      }
    }
    return largest;
  }
}
