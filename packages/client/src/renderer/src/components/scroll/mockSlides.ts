// Mock vault pictures for demo mode: drawn in code as SVG, so no image files ship with the app.
import type { FeedSlide } from './types';

const PALETTES: [string, string][] = [
  ['#ff6f91', '#ffc75f'], ['#4b7bec', '#a55eea'], ['#20bf6b', '#0fb9b1'],
  ['#fa8231', '#f7b731'], ['#45aaf2', '#2d98da'], ['#eb3b5a', '#fa8231'],
];
const COUNT = 12;

export const mockSlideIds = (): string[] => Array.from({ length: COUNT }, (_, i) => `demo-vault-${i + 1}`);

function svg(i: number): string {
  const [a, b] = PALETTES[i % PALETTES.length];
  const title = `Mock vault photo ${i + 1}`;
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="720" height="1280" fill="url(#g)"/>
  <circle cx="${180 + (i * 53) % 360}" cy="${260 + (i * 97) % 700}" r="${90 + (i * 17) % 80}" fill="#fff" fill-opacity=".18"/>
  <text x="360" y="640" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#fff">${title}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`;
}

export function mockSlides(): FeedSlide[] {
  return mockSlideIds().map((id, i) => ({
    id,
    title: `Mock vault photo ${i + 1}`,
    kind: 'image' as const,
    load: async () => svg(i),
    revoke: false,
  }));
}
