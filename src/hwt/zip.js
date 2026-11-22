import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;

// Standard IEEE 802.3 CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeFilename(rawBytes, flags) {
  if (flags & 0x0800) {
    return rawBytes.toString('utf8');
  }
  // Heuristic: valid UTF-8 multi-byte or ASCII
  const utf8Str = rawBytes.toString('utf8');
  if (!utf8Str.includes('\ufffd')) {
    return utf8Str;
  }
  try {
    return new TextDecoder('gbk').decode(rawBytes);
  } catch {
    return rawBytes.toString('latin1');
  }
}

function findEOCD(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        return i;
      }
    }
  }
  // Fallback without exact comment check
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return i;
    }
  }
  throw new Error('Invalid ZIP archive: EOCD signature not found');
}

export class HwtArchive {
  constructor(buffer, filePath = null) {
    this.buffer = buffer;
    this.filePath = filePath;
    this.entries = [];
    this.entryMap = new Map();
    this._parseCentralDirectory();
  }

  static open(filePath) {
    const buffer = fs.readFileSync(filePath);
    return new HwtArchive(buffer, filePath);
  }

  _parseCentralDirectory() {
    const buf = this.buffer;
    const eocdOff = findEOCD(buf);
    let totalEntries = buf.readUInt16LE(eocdOff + 10);
    let cdSize = buf.readUInt32LE(eocdOff + 12);
    let cdOffset = buf.readUInt32LE(eocdOff + 16);

    // Check Zip64 if sentinel values appear
    if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
      if (eocdOff >= 20 && buf.readUInt32LE(eocdOff - 20) === SIG_ZIP64_LOCATOR) {
        const z64Off = Number(buf.readBigUInt64LE(eocdOff - 12));
        if (buf.readUInt32LE(z64Off) === SIG_ZIP64_EOCD) {
          totalEntries = Number(buf.readBigUInt64LE(z64Off + 32));
          cdSize = Number(buf.readBigUInt64LE(z64Off + 40));
          cdOffset = Number(buf.readBigUInt64LE(z64Off + 48));
        }
      }
    }

    let pos = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (pos < cdEnd && pos + 46 <= buf.length) {
      const sig = buf.readUInt32LE(pos);
      if (sig !== SIG_CD) break;

      const versionMadeBy = buf.readUInt16LE(pos + 4);
      const versionNeeded = buf.readUInt16LE(pos + 6);
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const modTime = buf.readUInt16LE(pos + 12);
      const modDate = buf.readUInt16LE(pos + 14);
      const crc = buf.readUInt32LE(pos + 16);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const uncompressedSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const diskStart = buf.readUInt16LE(pos + 34);
      const internalAttr = buf.readUInt16LE(pos + 36);
      const externalAttr = buf.readUInt32LE(pos + 38);
      const localHeaderOffset = buf.readUInt32LE(pos + 42);

      const nameStart = pos + 46;
      const nameBytes = buf.subarray(nameStart, nameStart + nameLen);
      const name = decodeFilename(nameBytes, flags);
      const extraBytes = buf.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
      const commentBytes = buf.subarray(nameStart + nameLen + extraLen, nameStart + nameLen + extraLen + commentLen);

      const entry = {
        name,
        nameBytes,
        flags,
        method,
        modTime,
        modDate,
        crc,
        compressedSize,
        uncompressedSize,
        versionMadeBy,
        versionNeeded,
        diskStart,
        internalAttr,
        externalAttr,
        localHeaderOffset,
        extraBytes,
        commentBytes,
        isDirectory: name.endsWith('/'),
      };

      this.entries.push(entry);
      this.entryMap.set(name, entry);
      pos = nameStart + nameLen + extraLen + commentLen;
    }
  }

  has(name) {
    return this.entryMap.has(name);
  }

  getEntry(name) {
    return this.entryMap.get(name) || null;
  }

  list(prefix = '') {
    if (!prefix) return this.entries.map(e => e.name);
    return this.entries.filter(e => e.name.startsWith(prefix)).map(e => e.name);
  }

  readRawSlice(entry) {
    const off = entry.localHeaderOffset;
    if (this.buffer.readUInt32LE(off) !== SIG_LOCAL) {
      throw new Error(`Corrupt local header for entry: ${entry.name}`);
    }
    const localNameLen = this.buffer.readUInt16LE(off + 26);
    const localExtraLen = this.buffer.readUInt16LE(off + 28);
    const dataStart = off + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    return this.buffer.subarray(dataStart, dataEnd);
  }

  readBuffer(name) {
    const entry = typeof name === 'string' ? this.getEntry(name) : name;
    if (!entry) return null;
    if (entry.isDirectory || entry.uncompressedSize === 0 && entry.compressedSize === 0) {
      return Buffer.alloc(0);
    }
    if (entry.flags & 0x0001) {
      throw new Error(`Encrypted ZIP entry unsupported: ${entry.name}`);
    }
    const raw = this.readRawSlice(entry);
    if (entry.method === 0) {
      return Buffer.from(raw);
    }
    if (entry.method === 8) {
      return zlib.inflateRawSync(raw);
    }
    throw new Error(`Unsupported compression method ${entry.method} for entry: ${entry.name}`);
  }

  readText(name, encoding = 'utf8') {
    const buf = this.readBuffer(name);
    if (!buf) return null;
    // Strip UTF-8 BOM if present
    if (encoding === 'utf8' && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return buf.subarray(3).toString('utf8');
    }
    return buf.toString(encoding);
  }

  /**
   * Repack archive into a new Buffer, replacing or adding entries in `replacements` (Map<string, Buffer>).
   * Unchanged entries keep their original compressed payload & metadata with 0 recompression overhead.
   */
  repack(replacements) {
    const repMap = replacements instanceof Map ? replacements : new Map(Object.entries(replacements));
    const localParts = [];
    const cdParts = [];
    let offset = 0;

    const seen = new Set();

    const writeEntry = ({
      nameBytes,
      flags,
      method,
      modTime,
      modDate,
      crc,
      compressedBuf,
      uncompressedSize,
      versionMadeBy,
      versionNeeded,
      internalAttr,
      externalAttr,
      extraBytes,
      commentBytes,
    }) => {
      // Clear data-descriptor bit (0x08) since we write exact sizes & crc in local header
      const cleanFlags = flags & ~0x0008;
      const localHdr = Buffer.alloc(30);
      localHdr.writeUInt32LE(SIG_LOCAL, 0);
      localHdr.writeUInt16LE(versionNeeded || 20, 4);
      localHdr.writeUInt16LE(cleanFlags, 6);
      localHdr.writeUInt16LE(method, 8);
      localHdr.writeUInt16LE(modTime, 10);
      localHdr.writeUInt16LE(modDate, 12);
      localHdr.writeUInt32LE(crc >>> 0, 14);
      localHdr.writeUInt32LE(compressedBuf.length >>> 0, 18);
      localHdr.writeUInt32LE(uncompressedSize >>> 0, 22);
      localHdr.writeUInt16LE(nameBytes.length, 26);
      localHdr.writeUInt16LE(0, 28); // omit local extra to stay compact

      const localHeaderOffset = offset;
      localParts.push(localHdr, nameBytes, compressedBuf);
      offset += localHdr.length + nameBytes.length + compressedBuf.length;

      const cdHdr = Buffer.alloc(46);
      cdHdr.writeUInt32LE(SIG_CD, 0);
      cdHdr.writeUInt16LE(versionMadeBy || 20, 4);
      cdHdr.writeUInt16LE(versionNeeded || 20, 6);
      cdHdr.writeUInt16LE(cleanFlags, 8);
      cdHdr.writeUInt16LE(method, 10);
      cdHdr.writeUInt16LE(modTime, 12);
      cdHdr.writeUInt16LE(modDate, 14);
      cdHdr.writeUInt32LE(crc >>> 0, 16);
      cdHdr.writeUInt32LE(compressedBuf.length >>> 0, 20);
      cdHdr.writeUInt32LE(uncompressedSize >>> 0, 24);
      cdHdr.writeUInt16LE(nameBytes.length, 28);
      cdHdr.writeUInt16LE(extraBytes ? extraBytes.length : 0, 30);
      cdHdr.writeUInt16LE(commentBytes ? commentBytes.length : 0, 32);
      cdHdr.writeUInt16LE(0, 34);
      cdHdr.writeUInt16LE(internalAttr || 0, 36);
      cdHdr.writeUInt32LE(externalAttr || 0, 38);
      cdHdr.writeUInt32LE(localHeaderOffset >>> 0, 42);

      cdParts.push(cdHdr, nameBytes);
      if (extraBytes && extraBytes.length) cdParts.push(extraBytes);
      if (commentBytes && commentBytes.length) cdParts.push(commentBytes);
    };

    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

    for (const entry of this.entries) {
      seen.add(entry.name);
      if (repMap.has(entry.name)) {
        const plainBuf = Buffer.isBuffer(repMap.get(entry.name))
          ? repMap.get(entry.name)
          : Buffer.from(String(repMap.get(entry.name)), 'utf8');
        const deflated = zlib.deflateRawSync(plainBuf, { level: 6 });
        const useDeflate = deflated.length < plainBuf.length;
        writeEntry({
          nameBytes: Buffer.from(entry.name, 'utf8'),
          flags: 0x0800,
          method: useDeflate ? 8 : 0,
          modTime: dosTime,
          modDate: dosDate,
          crc: crc32(plainBuf),
          compressedBuf: useDeflate ? deflated : plainBuf,
          uncompressedSize: plainBuf.length,
          versionMadeBy: entry.versionMadeBy,
          versionNeeded: 20,
          internalAttr: entry.internalAttr,
          externalAttr: entry.externalAttr,
          extraBytes: Buffer.alloc(0),
          commentBytes: Buffer.alloc(0),
        });
      } else {
        const rawCompressed = this.readRawSlice(entry);
        writeEntry({
          nameBytes: entry.nameBytes,
          flags: entry.flags,
          method: entry.method,
          modTime: entry.modTime,
          modDate: entry.modDate,
          crc: entry.crc,
          compressedBuf: rawCompressed,
          uncompressedSize: entry.uncompressedSize,
          versionMadeBy: entry.versionMadeBy,
          versionNeeded: entry.versionNeeded,
          internalAttr: entry.internalAttr,
          externalAttr: entry.externalAttr,
          extraBytes: entry.extraBytes,
          commentBytes: entry.commentBytes,
        });
      }
    }

    for (const [name, content] of repMap.entries()) {
      if (seen.has(name)) continue;
      const plainBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      const deflated = zlib.deflateRawSync(plainBuf, { level: 6 });
      const useDeflate = deflated.length < plainBuf.length;
      writeEntry({
        nameBytes: Buffer.from(name, 'utf8'),
        flags: 0x0800,
        method: useDeflate ? 8 : 0,
        modTime: dosTime,
        modDate: dosDate,
        crc: crc32(plainBuf),
        compressedBuf: useDeflate ? deflated : plainBuf,
        uncompressedSize: plainBuf.length,
        versionMadeBy: 20,
        versionNeeded: 20,
        internalAttr: 0,
        externalAttr: 0,
        extraBytes: Buffer.alloc(0),
        commentBytes: Buffer.alloc(0),
      });
    }

    const cdOffset = offset;
    const cdBuf = Buffer.concat(cdParts);
    const totalEntries = seen.size + [...repMap.keys()].filter(k => !seen.has(k)).length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(totalEntries, 8);
    eocd.writeUInt16LE(totalEntries, 10);
    eocd.writeUInt32LE(cdBuf.length >>> 0, 12);
    eocd.writeUInt32LE(cdOffset >>> 0, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, cdBuf, eocd]);
  }
}
