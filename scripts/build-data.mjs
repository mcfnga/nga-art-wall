#!/usr/bin/env node
/**
 * Builds public/data/artworks.json from the National Gallery of Art open data
 * (https://github.com/NationalGalleryOfArt/opendata) and adds, for every
 * artwork, the 12 most visually similar artworks.
 *
 * Similarity is "color + composition": each thumbnail is reduced to
 *   (a) a CIELAB color histogram  -> which colors, and how much of each
 *   (b) a 4x4 grid of mean colors -> where light/dark/color sits in the frame
 * and artworks are compared by the distance between those vectors.
 * It matches on look and tone, NOT on subject matter.
 *
 * Environment variables (all optional):
 *   MAX_ARTWORKS      default 4000
 *   CLASSIFICATIONS   default "Painting"   (comma separated, e.g. "Painting,Drawing")
 *   OPEN_ACCESS_ONLY  default 1            (0 also includes images NGA has not marked open access)
 *   NEIGHBORS         default 12
 *   CONCURRENCY       default 6            (parallel thumbnail downloads)
 *   SKIP_SIMILARITY   set to 1 to write metadata only
 *   FORCE             set to 1 to rebuild even if the data file already has similarity
 *   CSV_DIR           folder holding objects.csv + published_images.csv (skips the download)
 *   IIIF_BASE         override the image server base URL (testing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'artworks.json');
const CACHE_DIR = path.join(ROOT, '.cache');
const FEATURE_CACHE = path.join(CACHE_DIR, 'features.json');
const DATA_URL = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/';

const env = process.env;
const MAX = parseInt(env.MAX_ARTWORKS || '4000', 10);
const CLASSES = new Set((env.CLASSIFICATIONS || 'Painting').split(',').map((s) => s.trim()).filter(Boolean));
const OPEN_ONLY = env.OPEN_ACCESS_ONLY !== '0';
const K = parseInt(env.NEIGHBORS || '12', 10);
const CONCURRENCY = parseInt(env.CONCURRENCY || '6', 10);
const FEATURE_VERSION = 1;

const log = (...a) => console.log('[build-data]', ...a);

/* ---------- CSV ---------- */

async function csvRows(name, onRow) {
  let input;
  if (env.CSV_DIR) {
    input = fs.createReadStream(path.join(env.CSV_DIR, name));
  } else {
    log('downloading', name);
    const res = await fetch(DATA_URL + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    input = Readable.fromWeb(res.body);
  }
  const parser = input.pipe(parse({ columns: true, relax_quotes: true, bom: true }));
  for await (const row of parser) onRow(row);
}

async function loadArtworks() {
  const objects = new Map();
  await csvRows('objects.csv', (r) => {
    if (!CLASSES.has(r.classification)) return;
    if (r.isvirtual === '1') return; // groupings, not individual artworks
    objects.set(r.objectid, r);
  });
  log(`${objects.size} objects classified as ${[...CLASSES].join(', ')}`);

  const images = new Map();
  await csvRows('published_images.csv', (r) => {
    if (r.viewtype !== 'primary') return;
    if (OPEN_ONLY && r.openaccess !== '1') return;
    if (!objects.has(r.depictstmsobjectid)) return;
    const w = parseInt(r.width, 10), h = parseInt(r.height, 10);
    if (!w || !h) return;
    const prev = images.get(r.depictstmsobjectid);
    if (prev && parseInt(prev.sequence, 10) <= parseInt(r.sequence, 10)) return;
    images.set(r.depictstmsobjectid, r);
  });

  let items = [];
  for (const [id, img] of images) {
    const o = objects.get(id);
    items.push({
      id: parseInt(id, 10),
      t: clean(o.title) || 'Untitled',
      a: clean(o.attribution),
      d: clean(o.displaydate),
      c: clean(o.creditline),
      u: img.uuid,
      w: parseInt(img.width, 10),
      h: parseInt(img.height, 10),
    });
  }
  items.sort((x, y) => x.id - y.id);
  log(`${items.length} of them have a${OPEN_ONLY ? 'n open-access' : ''} primary image`);

  if (items.length > MAX) {
    // deterministic sample so rebuilds are stable
    const rnd = mulberry32(20240607);
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    items = items.slice(0, MAX).sort((x, y) => x.id - y.id);
    log(`sampled down to ${items.length}`);
  }
  return items;
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- visual features ---------- */

const SIZE = 32;          // thumbnails are squashed to SIZE x SIZE before analysis
const GRID = 4;           // GRID x GRID layout cells
const LB = 4, AB = 8, BB = 8; // histogram bins for L, a, b
const HIST = LB * AB * BB;
const DIM = HIST + GRID * GRID * 3;
const W_HIST = 1.0;       // weight of "which colors"
const W_GRID = 1.0;       // weight of "where they are"

function srgbToLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** rgb: Uint8 array of SIZE*SIZE*3 -> plain number array of length DIM */
export function featuresFromRgb(rgb) {
  const v = new Float32Array(DIM);
  const cell = SIZE / GRID;
  const perCell = cell * cell;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 3;
      const [L, a, b] = srgbToLab(rgb[i], rgb[i + 1], rgb[i + 2]);
      const li = Math.min(LB - 1, Math.max(0, Math.floor((L / 100) * LB)));
      const ai = Math.min(AB - 1, Math.max(0, Math.floor(((a + 80) / 160) * AB)));
      const bi = Math.min(BB - 1, Math.max(0, Math.floor(((b + 80) / 160) * BB)));
      v[(li * AB + ai) * BB + bi] += 1;
      const g = HIST + (Math.floor(y / cell) * GRID + Math.floor(x / cell)) * 3;
      v[g] += L; v[g + 1] += a; v[g + 2] += b;
    }
  }
  const sh = Math.sqrt(W_HIST), sg = Math.sqrt(W_GRID);
  // sqrt of the normalised histogram -> Euclidean distance becomes Hellinger distance
  for (let i = 0; i < HIST; i++) v[i] = Math.sqrt(v[i] / (SIZE * SIZE)) * sh;
  for (let i = HIST; i < DIM; i++) v[i] = (v[i] / perCell / 100) * sg;
  return Array.from(v, (n) => Math.round(n * 1e4) / 1e4);
}

async function fetchFeatures(item, iiifBase, sharp) {
  const url = `${iiifBase}${item.u}/full/!128,128/0/default.jpg`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'nga-art-wall build script (open data thumbnails)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const rgb = await sharp(buf)
        .flatten({ background: '#ffffff' })
        .resize(SIZE, SIZE, { fit: 'fill' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer();
      if (rgb.length !== SIZE * SIZE * 3) throw new Error('unexpected pixel data');
      return featuresFromRgb(rgb);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** vectors: (number[]|null)[] -> for each index, the k nearest other indexes */
export function nearestNeighbors(vectors, k) {
  const n = vectors.length;
  const out = new Array(n);
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = vectors[i];
    if (!a) { out[i] = []; continue; }
    const cand = [];
    for (let j = 0; j < n; j++) {
      const b = vectors[j];
      if (j === i || !b) continue;
      let d = 0;
      for (let m = 0; m < a.length; m++) { const t = a[m] - b[m]; d += t * t; }
      dist[j] = d;
      cand.push(j);
    }
    cand.sort((p, q) => dist[p] - dist[q]);
    out[i] = cand.slice(0, k);
  }
  return out;
}

async function addSimilarity(items, iiifBase) {
  const sharp = (await import('sharp')).default;
  let cache = {};
  try {
    const c = JSON.parse(fs.readFileSync(FEATURE_CACHE, 'utf8'));
    if (c.version === FEATURE_VERSION) cache = c.features;
  } catch { /* no cache yet */ }

  const vectors = new Array(items.length).fill(null);
  let done = 0, failed = 0, next = 0;
  const started = Date.now();
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      try {
        vectors[i] = cache[it.u] || (cache[it.u] = await fetchFeatures(it, iiifBase, sharp));
      } catch (e) {
        failed++;
        if (failed <= 5) log(`  could not analyse object ${it.id}: ${e.message}`);
      }
      if (++done % 250 === 0) log(`  analysed ${done}/${items.length} thumbnails (${failed} failed)`);
      // give up early if the image server is clearly unreachable
      if (done === 40 && failed === 40) throw new Error('first 40 thumbnail downloads all failed');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(FEATURE_CACHE, JSON.stringify({ version: FEATURE_VERSION, features: cache }));
  log(`analysed ${done - failed}/${items.length} thumbnails in ${Math.round((Date.now() - started) / 1000)}s`);
  if (failed > items.length / 2) throw new Error(`${failed} of ${items.length} thumbnail downloads failed`);

  const nn = nearestNeighbors(vectors, K);
  items.forEach((it, i) => { it.s = nn[i]; });
}

/* ---------- main ---------- */

async function main() {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* none */ }
  if (existing?.hasSimilarity && !env.FORCE) {
    log('public/data/artworks.json already has similarity data; nothing to do (set FORCE=1 to rebuild).');
    return;
  }

  let items;
  try {
    items = await loadArtworks();
    if (!items.length) throw new Error('no artworks matched the filters');
  } catch (e) {
    if (existing) { log(`WARNING: could not load NGA open data (${e.message}). Keeping the existing data file.`); return; }
    throw e;
  }

  const iiifBase = env.IIIF_BASE || 'https://api.nga.gov/iiif/';
  let hasSimilarity = false;
  if (!env.SKIP_SIMILARITY) {
    try {
      await addSimilarity(items, iiifBase);
      hasSimilarity = true;
    } catch (e) {
      items.forEach((it) => delete it.s);
      log(`WARNING: visual similarity could not be computed (${e.message}).`);
      log('WARNING: the wall will still work, but the modal will show no similar artworks.');
    }
  }

  const data = {
    generated: new Date().toISOString(),
    source: 'National Gallery of Art open data, https://github.com/NationalGalleryOfArt/opendata',
    iiifBase,
    pageUrl: 'https://www.nga.gov/collection/art-object-page.{id}.html',
    hasSimilarity,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data));
  log(`wrote ${path.relative(ROOT, OUT)}: ${items.length} artworks, similarity: ${hasSimilarity ? 'yes' : 'no'}, ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[build-data] FAILED:', e); process.exit(1); });
}
