// Voice notes: WhatsApp sends OGG/Opus. Muse Voice Transcribe wants mono 16-bit WAV.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribeWav } from './meta.js';

export function toWav(inputPath) {
  const out = path.join(os.tmpdir(), `dfa-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inputPath, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', out]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`ffmpeg introuvable : ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`))));
  });
}

/** Transcribe any audio file. Arabic (incl. Moroccan Darija), French, English and Spanish are biased by default. */
export async function transcribeAudio(filePath, { languageBias = ['Arabic', 'French', 'English', 'Spanish'], keywords = [] } = {}) {
  const wav = filePath.toLowerCase().endsWith('.wav') ? filePath : await toWav(filePath);
  try {
    return await transcribeWav(wav, { languageBias, keywords });
  } finally {
    if (wav !== filePath) fs.rm(wav, { force: true }, () => {});
  }
}
