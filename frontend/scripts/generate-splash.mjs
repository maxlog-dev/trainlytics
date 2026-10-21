#!/usr/bin/env node
// Generates the iOS launch images (apple-touch-startup-image) and their <link>
// tags. iOS ignores the manifest's background_color: without a PNG that matches
// the device's exact screen size, a Home Screen launch starts on a white screen.
//
// Each image is a screenshot of index.html's boot placeholder (#boot-style and
// #boot-splash), rendered by headless Chromium at the device's CSS viewport and
// pixel ratio, so the launch image lines up with the page's first paint. The
// wordmark gets the self-hosted Montserrat 700. Chromium writes truecolor PNGs,
// which deflate can't shrink below ~1/1000 (12 KB for a flat 1206×2622 image),
// so they are re-encoded as palette PNGs of a few KB.
//
// Writes public/splash/*.png and rewrites the tags between the
// apple-touch-startup-image markers in index.html.
//
// Usage (from frontend/):  node scripts/generate-splash.mjs
// Needs Playwright's Chromium (`npx playwright install chromium`) or CHROME=<binary>,
// and `corepack pnpm install` (for the font).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(ROOT, 'index.html')
const OUT = join(ROOT, 'public', 'splash')
const FONT = join(ROOT, 'node_modules', '@fontsource', 'montserrat', 'files', 'montserrat-latin-700-normal.woff2')

// Screen sizes in CSS px (portrait) and device pixel ratio. iPhones launch from
// a portrait Home Screen; iPads get both orientations.
const PHONES = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // Air
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
  [390, 844, 3], // 12, 12 Pro, 13, 13 Pro, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6s Plus, 7 Plus, 8 Plus
  [375, 667, 2], // 6s, 7, 8, SE 2nd and 3rd gen
]
const TABLETS = [
  [1032, 1376, 2], // iPad Pro 13" (M4)
  [1024, 1366, 2], // iPad Pro 12.9", iPad Air 13"
  [834, 1210, 2], // iPad Pro 11" (M4)
  [834, 1194, 2], // iPad Pro 11" (1st–4th gen)
  [820, 1180, 2], // iPad Air 10.9"/11", iPad 10th gen and later
  [834, 1112, 2], // iPad Air 3rd gen, iPad Pro 10.5"
  [810, 1080, 2], // iPad 10.2" (7th–9th gen)
  [744, 1133, 2], // iPad mini 6th gen and later
  [768, 1024, 2], // iPad 9.7", iPad mini 5th gen
]
const SCREENS = [
  ...PHONES.map(([w, h, dpr]) => ({ w, h, dpr, orientation: 'portrait' })),
  ...TABLETS.flatMap(([w, h, dpr]) => [
    { w, h, dpr, orientation: 'portrait' },
    { w, h, dpr, orientation: 'landscape' },
  ]),
]

// ─── Page to screenshot ──────────────────────────────────────────────────────

function bootPage() {
  const html = readFileSync(INDEX, 'utf8')
  const style = html.match(/<style id="boot-style">([\s\S]*?)<\/style>/)?.[1]
  const splash = html.match(/<div id="boot-splash">[\s\S]*?<\/svg>\s*<\/div>/)?.[0]
  if (!style || !splash) throw new Error('index.html: #boot-style or #boot-splash not found')
  if (!existsSync(FONT)) throw new Error(`${FONT} not found: run \`corepack pnpm install\``)
  const font = readFileSync(FONT).toString('base64')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
@font-face { font-family: 'Montserrat'; font-weight: 700; font-display: block;
  src: url(data:font/woff2;base64,${font}) format('woff2'); }
${style}
</style></head>
<body>${splash}</body></html>`
}

// ─── Chromium ────────────────────────────────────────────────────────────────

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const candidates = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort() : []
  for (const dir of candidates.reverse()) {
    for (const sub of readdirSync(join(root, dir))) {
      const bin = join(root, dir, sub, 'chrome-headless-shell')
      if (existsSync(bin)) return bin
    }
  }
  throw new Error('Chromium not found: run `npx playwright install chromium` or set CHROME=<binary>')
}

function screenshot(chrome, page, { width, height, dpr }, png) {
  execFileSync(chrome, [
    '--headless',
    '--hide-scrollbars',
    `--force-device-scale-factor=${dpr}`,
    `--window-size=${width},${height}`,
    // Lets the font finish loading before the shot is taken
    '--virtual-time-budget=2000',
    `--screenshot=${png}`,
    `file://${page}`,
  ], { stdio: 'ignore' })
}

// ─── PNG: decode Chromium's truecolor output, re-encode with a palette ───────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function readPng(buf) {
  let pos = 8
  let ihdr
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const [depth, colorType, , , interlace] = ihdr.subarray(8)
  const bpp = { 2: 3, 6: 4 }[colorType]
  if (depth !== 8 || !bpp || interlace) throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = px.subarray(y * stride, (y + 1) * stride)
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = up ? up[i] : 0
      const c = up && i >= bpp ? up[i - bpp] : 0
      let v = src[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      row[i] = v
    }
  }
  return { width, height, bpp, px }
}

// The artwork is a handful of flat colours plus their anti-aliased edges: keep
// the 256 most frequent colours and map any others to the nearest of them.
function toPalettePng({ width, height, bpp, px }) {
  const rgb = (i) => (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]
  const counts = new Map()
  for (let i = 0; i < px.length; i += bpp) counts.set(rgb(i), (counts.get(rgb(i)) ?? 0) + 1)
  const palette = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 256).map(([c]) => c)
  const index = new Map(palette.map((c, i) => [c, i]))
  const nearest = (c) => {
    let best = 0
    let bestD = Infinity
    palette.forEach((p, i) => {
      const d = ((p >> 16) - (c >> 16)) ** 2 + (((p >> 8) & 255) - ((c >> 8) & 255)) ** 2 + ((p & 255) - (c & 255)) ** 2
      if (d < bestD) [best, bestD] = [i, d]
    })
    index.set(c, best)
    return best
  }

  const raw = Buffer.alloc(height * (width + 1)) // filter byte 0 (None) per row
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = rgb((y * width + x) * bpp)
      raw[y * (width + 1) + 1 + x] = index.get(c) ?? nearest(c)
    }
  }

  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 3, 0, 0, 0], 8) // 8-bit, palette, no interlace
  const plte = Buffer.from(palette.flatMap((c) => [c >> 16, (c >> 8) & 255, c & 255]))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const chrome = findChrome()
const work = mkdtempSync(join(tmpdir(), 'trainlytics-splash-'))
const page = join(work, 'boot.html')
writeFileSync(page, bootPage())
mkdirSync(OUT, { recursive: true })

console.log('Writing launch images:')
const links = []
const written = new Set()
let total = 0
for (const { w, h, dpr, orientation } of SCREENS) {
  const [width, height] = orientation === 'portrait' ? [w, h] : [h, w]
  const name = `apple-splash-${width * dpr}-${height * dpr}.png`
  const shot = join(work, name)
  screenshot(chrome, page, { width, height, dpr }, shot)
  const decoded = readPng(readFileSync(shot))
  if (decoded.width !== width * dpr || decoded.height !== height * dpr) {
    throw new Error(`${name}: Chromium rendered ${decoded.width}×${decoded.height}`)
  }
  const png = toPalettePng(decoded)
  writeFileSync(join(OUT, name), png)
  written.add(name)
  total += png.length
  console.log(`  public/splash/${name} (${(png.length / 1024).toFixed(1)} KB)`)
  links.push(
    `<link rel="apple-touch-startup-image" media="screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation})" href="/splash/${name}" />`,
  )
}
for (const f of readdirSync(OUT)) {
  if (f.startsWith('apple-splash-') && !written.has(f)) {
    rmSync(join(OUT, f))
    console.log(`  removed stale public/splash/${f}`)
  }
}
console.log(`  ${written.size} images, ${(total / 1024).toFixed(0)} KB in total`)

const MARKERS = /(<!-- apple-touch-startup-image:start[^>]*-->)[\s\S]*?(\n(\s*)<!-- apple-touch-startup-image:end -->)/
const html = readFileSync(INDEX, 'utf8')
const match = html.match(MARKERS)
if (!match) throw new Error('index.html: apple-touch-startup-image markers not found')
const indent = match[3]
writeFileSync(INDEX, html.replace(MARKERS, (_, start, end) => `${start}\n${links.map((l) => indent + l).join('\n')}${end}`))
console.log('Updated the apple-touch-startup-image links in index.html')
rmSync(work, { recursive: true, force: true })
