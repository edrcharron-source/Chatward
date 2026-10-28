// Generated media for the demo world: avatars (PNG via canvas), GIF cards (animated SVG), sound clips (WAV).

const cache = new Map<string, Promise<Uint8Array>>();

function memo(key: string, make: () => Promise<Uint8Array>): Promise<Uint8Array> {
  let hit = cache.get(key);
  if (!hit) { hit = make(); cache.set(key, hit); }
  return hit;
}

/** Round avatar with the first letter of the name. <img> needs a real raster type, so this is PNG. */
export function avatarPng(name: string, hue: number): Promise<Uint8Array> {
  return memo(`avatar:${name}:${hue}`, async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = `hsl(${hue} 60% 45%)`;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.charAt(0).toUpperCase(), 64, 68);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png failed'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  });
}

/** Animated SVG card used as a GIF result. Returned as a data URL, so no network. */
export function gifDataUrl(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">`
    + `<rect width="320" height="200" fill="hsl(${hue} 70% 45%)">`
    + `<animate attributeName="fill" values="hsl(${hue} 70% 45%);hsl(${hue + 60} 70% 45%);hsl(${hue} 70% 45%)" dur="2.4s" repeatCount="indefinite"/></rect>`
    + `<text x="160" y="112" font-size="30" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Simple illustrated image used as an uploaded picture in seed messages. */
export function sunsetSvg(): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7e5f"/><stop offset="1" stop-color="#3b1f5c"/></linearGradient></defs>`
    + `<rect width="640" height="400" fill="url(#g)"/><circle cx="320" cy="250" r="90" fill="#ffd166"/>`
    + `<rect y="280" width="640" height="120" fill="#1b1036"/></svg>`;
  return new TextEncoder().encode(svg);
}

/** Mono 16-bit WAV: a sine tone with a short fade in and out. */
export function toneWav(freq: number, ms: number): Uint8Array {
  const rate = 22050;
  const n = Math.floor((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / (rate * 0.01), (n - i) / (rate * 0.05));
    const s = Math.sin((2 * Math.PI * freq * i) / rate) * 0.4 * fade;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}
