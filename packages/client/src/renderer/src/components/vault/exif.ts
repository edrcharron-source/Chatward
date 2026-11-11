/**
 * Just enough JPEG EXIF reading for the Vault: when the photo was taken, which camera took it, and removing location
 * data before the photo is encrypted. Anything unexpected leaves the bytes as they were and reports nothing.
 */

export interface PhotoFacts {
  /** DateTimeOriginal as ms epoch, using the photo's own time zone offset when it records one, else local time. */
  takenAt?: number;
  camera?: string;
  hasGps: boolean;
}

const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Tiff { view: DataView; start: number; end: number; le: boolean }
interface Entry { tag: number; type: number; count: number; at: number /* entry offset */; valueAt: number /* absolute */; bytes: number }

/** Finds each APP1 segment: [start of its data, end of its data]. Stops at the image data. */
function app1Segments(b: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end: no more metadata
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    if (marker === 0xe1) out.push([i + 4, i + 2 + len]);
    i += 2 + len;
  }
  return out;
}

function tiffAt(b: Uint8Array, [start, end]: [number, number]): Tiff | null {
  // "Exif\0\0" then the TIFF header
  if (end - start < 14 || b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66 || b[start + 4] !== 0 || b[start + 5] !== 0) return null;
  const t = start + 6;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const order = view.getUint16(t);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  if (view.getUint16(t + 2, le) !== 42) return null;
  return { view, start: t, end, le };
}

function readIfd(tf: Tiff, offset: number): Entry[] | null {
  const at = tf.start + offset;
  if (offset < 8 || at + 2 > tf.end) return null;
  const n = tf.view.getUint16(at, tf.le);
  if (at + 2 + n * 12 > tf.end) return null;
  const entries: Entry[] = [];
  for (let k = 0; k < n; k++) {
    const e = at + 2 + k * 12;
    const tag = tf.view.getUint16(e, tf.le);
    const type = tf.view.getUint16(e + 2, tf.le);
    const count = tf.view.getUint32(e + 4, tf.le);
    const bytes = (TYPE_BYTES[type] ?? 1) * count;
    const valueAt = bytes <= 4 ? e + 8 : tf.start + tf.view.getUint32(e + 8, tf.le);
    entries.push({ tag, type, count, at: e, valueAt, bytes });
  }
  return entries;
}

const ascii = (tf: Tiff, e: Entry | undefined): string | undefined => {
  if (!e || e.type !== 2 || e.valueAt + e.bytes > tf.end) return undefined;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = tf.view.getUint8(e.valueAt + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || undefined;
};
const pointer = (tf: Tiff, e: Entry | undefined) => (e && (e.type === 4 || e.type === 13) ? tf.view.getUint32(e.at + 8, tf.le) : undefined);

/** "2026:11:08 14:03:22" plus an optional "+05:00" offset to ms epoch. */
export function parseExifDate(s: string | undefined, offset?: string): number | undefined {
  const m = s && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const o = offset && /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (o) {
    const shift = (Number(o[2]) * 60 + Number(o[3])) * 60_000 * (o[1] === '-' ? -1 : 1);
    return Date.UTC(y, mo - 1, d, h, mi, se) - shift;
  }
  const t = new Date(y, mo - 1, d, h, mi, se).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** Reads the capture date, camera and whether location is present. Never throws. */
export function readPhotoFacts(b: Uint8Array): PhotoFacts {
  const facts: PhotoFacts = { hasGps: false };
  try {
    for (const seg of app1Segments(b)) {
      const tf = tiffAt(b, seg);
      if (!tf) continue;
      const ifd0 = readIfd(tf, tf.view.getUint32(tf.start + 4, tf.le));
      if (!ifd0) continue;
      const find = (list: Entry[], tag: number) => list.find((e) => e.tag === tag);
      const make = ascii(tf, find(ifd0, 0x010f));
      const model = ascii(tf, find(ifd0, 0x0110));
      if (make || model) facts.camera = model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
      const gpsOff = pointer(tf, find(ifd0, 0x8825));
      const gps = gpsOff ? readIfd(tf, gpsOff) : null;
      facts.hasGps = !!gps?.some((e) => e.tag >= 1 && e.tag <= 4);
      const exifOff = pointer(tf, find(ifd0, 0x8769));
      const exif = exifOff ? readIfd(tf, exifOff) : null;
      if (exif) facts.takenAt = parseExifDate(ascii(tf, find(exif, 0x9003)) ?? ascii(tf, find(exif, 0x9004)), ascii(tf, find(exif, 0x9011)));
      facts.takenAt ??= parseExifDate(ascii(tf, find(ifd0, 0x0132)));
      break;
    }
    if (!facts.hasGps && xmpWithGps(b)) facts.hasGps = true;
  } catch { /* a damaged header just means no facts */ }
  return facts;
}

const XMP_ID = 'http://ns.adobe.com/xap/1.0/';
function segmentText(b: Uint8Array, [start, end]: [number, number], max = end - start) {
  let s = '';
  for (let i = start; i < Math.min(end, start + max); i++) s += String.fromCharCode(b[i]);
  return s;
}
/** The APP1 XMP segment, if it records a location. Returns the whole segment including its marker. */
function xmpWithGps(b: Uint8Array): [number, number] | null {
  for (const seg of app1Segments(b)) {
    if (segmentText(b, seg, XMP_ID.length) !== XMP_ID) continue;
    if (/GPSLatitude|GPSLongitude/.test(segmentText(b, seg))) return [seg[0] - 4, seg[1]];
  }
  return null;
}

/**
 * Returns a copy of a JPEG without location: the EXIF GPS entries and their values are zeroed and the GPS folder is
 * left empty, so every other offset in the file still holds. An XMP block that names a location is dropped.
 * Non-JPEG bytes come back unchanged. `removed` says whether anything was taken out.
 */
export function stripGps(input: Uint8Array): { bytes: Uint8Array; removed: boolean } {
  try {
    let b = input;
    let removed = false;
    const xmp = xmpWithGps(b);
    if (xmp) {
      const out = new Uint8Array(b.length - (xmp[1] - xmp[0]));
      out.set(b.subarray(0, xmp[0]));
      out.set(b.subarray(xmp[1]), xmp[0]);
      b = out;
      removed = true;
    }
    for (const seg of app1Segments(b)) {
      const tf = tiffAt(b, seg);
      if (!tf) continue;
      const ifd0 = readIfd(tf, tf.view.getUint32(tf.start + 4, tf.le));
      const gpsOff = ifd0 ? pointer(tf, ifd0.find((e) => e.tag === 0x8825)) : undefined;
      const gps = gpsOff ? readIfd(tf, gpsOff) : null;
      if (!gps || !gps.length) break;
      if (b === input) b = input.slice();
      for (const e of gps) {
        if (e.bytes > 4 && e.valueAt >= tf.start && e.valueAt + e.bytes <= tf.end) b.fill(0, e.valueAt, e.valueAt + e.bytes);
        b.fill(0, e.at, e.at + 12);
      }
      const at = tf.start + gpsOff!;
      b[at] = 0; b[at + 1] = 0; // entry count
      removed = true;
      break;
    }
    return { bytes: b, removed };
  } catch {
    return { bytes: input, removed: false };
  }
}
