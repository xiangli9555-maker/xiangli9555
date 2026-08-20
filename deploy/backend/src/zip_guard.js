'use strict';

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw Object.assign(new Error('invalid_zip'), { status: 400 });
}

function assertZipSafe(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw Object.assign(new Error('invalid_zip'), { status: 400 });
  }
  const maxEntries = Number(options.maxEntries || 2_000);
  const maxEntryUncompressed = Number(options.maxEntryUncompressed || 25 * 1024 * 1024);
  const maxTotalUncompressed = Number(options.maxTotalUncompressed || 100 * 1024 * 1024);
  const maxCompressionRatio = Number(options.maxCompressionRatio || 150);

  const eocd = findEocd(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > maxEntries || centralOffset >= buffer.length) {
    throw Object.assign(new Error('zip_limits_exceeded'), { status: 413 });
  }

  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw Object.assign(new Error('invalid_zip_directory'), { status: 400 });
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length || (flags & 0x1) !== 0) {
      throw Object.assign(new Error('unsupported_zip'), { status: 400 });
    }
    totalUncompressed += uncompressed;
    const ratio = uncompressed / Math.max(1, compressed);
    if (
      uncompressed > maxEntryUncompressed ||
      totalUncompressed > maxTotalUncompressed ||
      (uncompressed > 1024 * 1024 && ratio > maxCompressionRatio)
    ) {
      throw Object.assign(new Error('zip_limits_exceeded'), { status: 413 });
    }
    offset = nextOffset;
  }
  return { entries, totalUncompressed };
}

module.exports = { assertZipSafe };
