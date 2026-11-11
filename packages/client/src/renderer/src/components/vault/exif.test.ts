import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExifDate, readPhotoFacts, stripGps } from './exif';

/** Builds a tiny big-endian JPEG with EXIF: make, model, capture date and offset, and a GPS position. */
function jpeg({ gps = true, xmpGps = false, date = '2026:11:08 14:03:22', offset = '-05:00' } = {}): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => tiff.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  // Layout (offsets from the TIFF start): header 8, IFD0 at 8 with 4 entries, ExifIFD, GPS IFD, then values.
  const make = str('Apple'); const model = str('iPhone 15 Pro'); const dt = str(date); const off = str(offset);
  const ifd0At = 8, ifd0Len = 2 + 4 * 12 + 4;
  const exifAt = ifd0At + ifd0Len, exifLen = 2 + 2 * 12 + 4;
  const gpsAt = exifAt + exifLen, gpsLen = 2 + 2 * 12 + 4;
  let v = gpsAt + gpsLen;
  const makeAt = v; v += make.length;
  const modelAt = v; v += model.length;
  const dtAt = v; v += dt.length;
  const offAt = v; v += off.length; // 7 bytes, stored out of line
  const latAt = v; v += 24;
  tiff.push(0x4d, 0x4d); u16(42); u32(ifd0At);
  u16(4);
  u16(0x010f); u16(2); u32(make.length); u32(makeAt);
  u16(0x0110); u16(2); u32(model.length); u32(modelAt);
  u16(0x8769); u16(4); u32(1); u32(exifAt);
  u16(0x8825); u16(4); u32(1); u32(gps ? gpsAt : 0);
  u32(0);
  u16(2);
  u16(0x9003); u16(2); u32(dt.length); u32(dtAt);
  u16(0x9011); u16(2); u32(off.length); u32(offAt);
  u32(0);
  u16(2);
  u16(0x0001); u16(2); u32(2); tiff.push(0x4e, 0, 0, 0); // 'N'
  u16(0x0002); u16(5); u32(3); u32(latAt);
  u32(0);
  tiff.push(...make, ...model, ...dt, ...off);
  for (const n of [40, 1, 26, 1, 4479, 100]) u32(n);
  const exifData = [...str('Exif'), 0, ...tiff];
  const seg = (marker: number, data: number[]) => [0xff, marker, ((data.length + 2) >> 8) & 255, (data.length + 2) & 255, ...data];
  const xmp = xmpGps ? seg(0xe1, [...str('http://ns.adobe.com/xap/1.0/'), ...str('<x:xmpmeta exif:GPSLatitude="40,26.7N"/>')]) : [];
  return new Uint8Array([0xff, 0xd8, ...seg(0xe1, exifData), ...xmp, ...seg(0xda, [0, 0, 0]), 1, 2, 3, 0xff, 0xd9]);
}

test('reads the capture date with its offset, the camera and the location flag', () => {
  const f = readPhotoFacts(jpeg());
  assert.equal(f.takenAt, Date.UTC(2026, 10, 8, 19, 3, 22));
  assert.equal(f.camera, 'Apple iPhone 15 Pro');
  assert.equal(f.hasGps, true);
});

test('strips GPS but keeps the date, camera and the image bytes', () => {
  const src = jpeg();
  const { bytes, removed } = stripGps(src);
  assert.equal(removed, true);
  assert.equal(bytes.length, src.length, 'same size, so offsets still hold');
  const f = readPhotoFacts(bytes);
  assert.equal(f.hasGps, false);
  assert.equal(f.camera, 'Apple iPhone 15 Pro');
  assert.equal(f.takenAt, Date.UTC(2026, 10, 8, 19, 3, 22));
  assert.deepEqual([...bytes.slice(-5)], [1, 2, 3, 0xff, 0xd9]);
  assert.ok(![...bytes].some((_, i) => bytes[i] === 0x11 && bytes[i + 1] === 0x7f), 'the longitude value is gone');
  assert.equal(readPhotoFacts(src).hasGps, true, 'the input is not changed');
});

test('drops an XMP block that names a location', () => {
  const src = jpeg({ gps: false, xmpGps: true });
  assert.equal(readPhotoFacts(src).hasGps, true);
  const { bytes, removed } = stripGps(src);
  assert.equal(removed, true);
  assert.ok(bytes.length < src.length);
  assert.equal(readPhotoFacts(bytes).hasGps, false);
  assert.equal(readPhotoFacts(bytes).camera, 'Apple iPhone 15 Pro');
});

test('leaves photos without location, and non-JPEGs, alone', () => {
  const clean = jpeg({ gps: false });
  assert.equal(stripGps(clean).removed, false);
  assert.equal(stripGps(clean).bytes, clean);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.deepEqual(stripGps(png), { bytes: png, removed: false });
  assert.deepEqual(readPhotoFacts(png), { hasGps: false });
  assert.deepEqual(readPhotoFacts(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0])), { hasGps: false }, 'a broken header is ignored');
});

test('parses EXIF dates', () => {
  assert.equal(parseExifDate('2026:01:02 03:04:05', '+00:00'), Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(parseExifDate('2026:01:02 03:04:05'), new Date(2026, 0, 2, 3, 4, 5).getTime());
  assert.equal(parseExifDate('0000:00:00 00:00:00'), undefined);
  assert.equal(parseExifDate(undefined), undefined);
});
