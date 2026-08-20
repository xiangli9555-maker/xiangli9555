'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertZipSafe } = require('../src/zip_guard');

function centralOnlyZip({ name = 'file.xml', compressed = 10, uncompressed = 10, flags = 0 } = {}) {
  const nameBuffer = Buffer.from(name);
  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(flags, 8);
  central.writeUInt32LE(compressed, 20);
  central.writeUInt32LE(uncompressed, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  nameBuffer.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

test('accepts a small declared ZIP archive', () => {
  assert.deepEqual(assertZipSafe(centralOnlyZip()), { entries: 1, totalUncompressed: 10 });
});

test('rejects invalid ZIP input', () => {
  assert.throws(() => assertZipSafe(Buffer.from('not-a-zip')), /invalid_zip/);
});

test('rejects oversized decompressed entries', () => {
  const payload = centralOnlyZip({ compressed: 100, uncompressed: 30 * 1024 * 1024 });
  assert.throws(
    () => assertZipSafe(payload, { maxEntryUncompressed: 25 * 1024 * 1024 }),
    /zip_limits_exceeded/
  );
});

test('rejects suspicious compression ratios', () => {
  const payload = centralOnlyZip({ compressed: 1_000, uncompressed: 10 * 1024 * 1024 });
  assert.throws(() => assertZipSafe(payload, { maxCompressionRatio: 100 }), /zip_limits_exceeded/);
});

test('rejects encrypted archives', () => {
  assert.throws(() => assertZipSafe(centralOnlyZip({ flags: 1 })), /unsupported_zip/);
});
