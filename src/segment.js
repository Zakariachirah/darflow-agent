// Document finder: SAM 3.1 locates every sheet of paper in a staff photo (a bill on a
// marble counter, three receipts side by side...). Each one is cropped and read on its
// own, so Muse Spark sees only the document, at full resolution, without the background.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { post, outputText } from './meta.js';

// Concept prompts, tried in order until one finds something (tested on real riad photos:
// "sheet of paper" 0.95–0.97 confidence; "invoice" finds nothing).
const PROMPTS = ['sheet of paper', 'document', 'receipt'];
const MIN_CONFIDENCE = 0.4;
const MIN_AREA = 0.04; // a document covers at least 4 % of the photo

/** Parse SAM's output tokens: <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|> */
export function parseBoxes(text) {
  return [...String(text).matchAll(/<\|box;([^|]+)\|>/g)].map((m) => {
    const o = Object.fromEntries(m[1].split(';').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
    return { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: o.w, h: o.h, c: o.c ?? 1 };
  });
}

const area = (b) => Math.max(0, b.x2 - b.x1 + 1) * Math.max(0, b.y2 - b.y1 + 1);
const inter = (a, b) => area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) });

/** Keep real documents: confident, big enough, not nested in another one; reading order. */
export function pickDocuments(boxes, w, h) {
  const big = boxes.filter((b) => b.c >= MIN_CONFIDENCE && area(b) >= MIN_AREA * w * h).sort((a, b) => area(b) - area(a));
  const kept = [];
  for (const b of big) if (!kept.some((k) => inter(k, b) > 0.8 * area(b))) kept.push(b);
  const rowH = h / 6;
  return kept.sort((a, b) => Math.floor(a.y1 / rowH) - Math.floor(b.y1 / rowH) || a.x1 - b.x1);
}

function ffmpeg(args) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]); }
function size(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  return { w, h };
}

/**
 * Find the documents in a photo. Returns { crops: [{ path, box }], full, used }.
 * Never throws: if segmentation is off, fails or finds nothing, the whole photo is used.
 */
export async function findDocuments(imagePath, { onLog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-seg-'));
  const full = path.join(dir, 'full.jpg');
  // Normalise: apply EXIF rotation, cap the long side, JPEG — the same pixels SAM and Spark see.
  ffmpeg(['-i', imagePath, '-vf', "scale='if(gt(iw,ih),min(2000,iw),-2)':'if(gt(iw,ih),-2,min(2000,ih))'", '-q:v', '2', full]);
  const model = config.meta.segmentModel;
  if (!model || model === 'off') return { crops: [], full, used: 'off' };
  const { w, h } = size(full);
  const image_url = `data:image/jpeg;base64,${fs.readFileSync(full).toString('base64')}`;
  for (const prompt of PROMPTS) {
    let boxes;
    try {
      const resp = await post('/responses', {
        model, metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url }] }],
      }, { timeoutMs: 60_000 });
      boxes = pickDocuments(parseBoxes(outputText(resp)), w, h);
    } catch (e) {
      onLog?.(`segmentation failed: ${e.message}`);
      return { crops: [], full, used: 'error' };
    }
    if (!boxes.length) continue;
    const crops = boxes.map((b, i) => {
      const pad = Math.round(0.015 * Math.max(w, h));
      const x = Math.max(0, b.x1 - pad), y = Math.max(0, b.y1 - pad);
      const cw = Math.min(w, b.x2 + pad + 1) - x, ch = Math.min(h, b.y2 + pad + 1) - y;
      const out = path.join(dir, `doc-${i + 1}.jpg`);
      ffmpeg(['-i', full, '-vf', `crop=${cw}:${ch}:${x}:${y}`, '-q:v', '2', out]);
      return { path: out, box: b };
    });
    return { crops, full, used: prompt };
  }
  return { crops: [], full, used: 'none_found' };
}
