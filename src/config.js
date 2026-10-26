// Configuration: reads secrets from a local env file that is never committed.
// Accepted file names: .env, "api key.env" (any *.env at the project root).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFiles() {
  let files = [];
  try { files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.env') && !f.endsWith('.example.env')); } catch { /* none */ }
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnvFiles();

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  meta: {
    baseUrl: env('MODEL_API_BASE', 'https://api.meta.ai/v1'),
    apiKey: env('MODEL_API_KEY'),
    // Standard mode only: guest data must never go to a "-contributor" model.
    agentModel: env('AGENT_MODEL', 'muse-spark-1.3'),
    visionModel: env('VISION_MODEL', 'muse-spark-1.3'),
    transcribeModel: env('TRANSCRIBE_MODEL', 'muse-voice-transcribe-1.0'),
    segmentModel: env('SEGMENT_MODEL', 'sam-3.1'), // '' or 'off' disables document cropping
  },
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    graphVersion: env('WHATSAPP_GRAPH_VERSION', 'v23.0'),
    checkinTemplate: env('WHATSAPP_CHECKIN_TEMPLATE', ''),
    appId: env('WHATSAPP_APP_ID'),
    businessAccountId: env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
  },
  // Riad profile: private real file if present, otherwise the public demo riad.
  profileFile: env('RIAD_PROFILE', fs.existsSync(path.join(ROOT, 'private', 'riad-profile.md'))
    ? path.join(ROOT, 'private', 'riad-profile.md')
    : path.join(ROOT, 'examples', 'dar-demo-profile.md')),
  dataDir: env('DATA_DIR', path.join(ROOT, 'data')),
  port: Number(env('PORT', '8790')),
  managerPhone: env('MANAGER_WHATSAPP', ''),
  checkinBaseUrl: env('CHECKIN_BASE_URL', 'https://checkin.example/c/'),
  outreachDaysBefore: Number(env('OUTREACH_DAYS_BEFORE', '3')),
};

export function assertMetaKey() {
  if (!config.meta.apiKey) throw new Error('MODEL_API_KEY manquante : ajoutez-la dans un fichier .env à la racine du projet.');
}
