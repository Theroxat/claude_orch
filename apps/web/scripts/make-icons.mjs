// Regenerates the PNG app icons in public/ from the logo geometry (Brand.tsx).
// Run from the repo root:
//   docker run --rm -u "$(id -u)" -v "$PWD:/w" -w /tmp node:24-slim sh -c \
//     "npm i sharp@latest && node /w/apps/web/scripts/make-icons.mjs /w/apps/web/public"
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2];
const INK = '#142029';
const LIGHT = '#f3f6f1';
const PROCEED = '#d97757';

function mark(size, scale, track, signal) {
  const w = 34 * scale;
  const h = 22 * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M2 4c9 0 11 7 20 7M2 18c9 0 11-7 20-7M2 11h22" fill="none" stroke="${track}" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="28.5" cy="11" r="3.5" fill="${signal}"/></g>`;
}
function svg(size, { radius = 0, bg = INK, scale, track = LIGHT, signal = PROCEED }) {
  const rect = bg ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rect}${mark(size, scale, track, signal)}</svg>`;
}
const png = (name, s, opts) =>
  sharp(Buffer.from(svg(s, opts)))
    .png()
    .toFile(join(out, name));

// "any": rounded tile, mark ~64% wide. Maskable: full bleed, mark inside the 80% safe circle.
const any = (s) => ({ radius: s * 0.22, scale: (s * 0.64) / 34 });
await png('icon-192.png', 192, any(192));
await png('icon-512.png', 512, any(512));
await png('apple-touch-icon.png', 180, { radius: 0, scale: (180 * 0.6) / 34 });
await png('icon-maskable-512.png', 512, { radius: 0, scale: (512 * 0.5) / 34 });
await png('icon-monochrome-512.png', 512, {
  bg: null,
  scale: (512 * 0.5) / 34,
  track: '#000',
  signal: '#000',
});
await writeFile(join(out, 'favicon.svg'), svg(64, { radius: 14, scale: (64 * 0.7) / 34 }));
