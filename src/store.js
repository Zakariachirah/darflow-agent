// Small JSON-file store standing in for the property management system.
// In production this is replaced by the DarFlow adapter (see src/darflow-adapter.js);
// the agent only talks to this interface.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = () => path.join(config.dataDir, 'store.json');
const EMPTY = { reservations: [], conversations: {}, requests: [], handoffs: [], expenses: [], events: [] };

let cache = null;
export function load() {
  if (cache) return cache;
  try { cache = { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; }
  catch { cache = structuredClone(EMPTY); }
  return cache;
}
export function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE());
}
export function reset(seed = {}) { cache = { ...structuredClone(EMPTY), ...structuredClone(seed) }; save(); }

const id = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const normPhone = (p) => String(p || '').replace(/[^\d]/g, '');

export function log(type, data) { load().events.push({ at: new Date().toISOString(), type, ...data }); save(); }

// ---- reservations ----
export function reservationByPhone(phone) {
  const n = normPhone(phone);
  const today = new Date().toISOString().slice(0, 10);
  return load().reservations
    .filter((r) => normPhone(r.phone) === n && r.status !== 'cancelled' && r.checkout >= today)
    .sort((a, b) => a.checkin.localeCompare(b.checkin))[0] || null;
}
export function reservationById(rid) { return load().reservations.find((r) => r.id === rid) || null; }
export function updateReservation(rid, patch) {
  const r = reservationById(rid);
  if (!r) return null;
  Object.assign(r, patch);
  save();
  return r;
}

// ---- conversations (per phone) ----
export function history(phone) { return load().conversations[normPhone(phone)] || []; }
export function append(phone, role, text, extra = {}) {
  const s = load();
  const k = normPhone(phone);
  (s.conversations[k] ||= []).push({ at: new Date().toISOString(), role, text, ...extra });
  save();
}
export function isHandedOff(phone) {
  return load().handoffs.some((h) => normPhone(h.phone) === normPhone(phone) && h.status === 'open');
}

// ---- requests & handoffs (what the manager sees) ----
export function updateRequest(id, patch) {
  const r = load().requests.find((x) => x.id === id);
  if (r) { Object.assign(r, patch, { updatedAt: new Date().toISOString() }); save(); }
  return r;
}
export function addRequest(data) {
  const r = { id: id('req'), at: new Date().toISOString(), status: 'pending', ...data };
  load().requests.push(r); save(); return r;
}
export function addHandoff(data) {
  const h = { id: id('ho'), at: new Date().toISOString(), status: 'open', ...data };
  load().handoffs.push(h); save(); return h;
}
export function closeHandoff(phone) {
  for (const h of load().handoffs) if (normPhone(h.phone) === normPhone(phone)) h.status = 'closed';
  save();
}

// ---- expenses ----
export function addExpense(data) {
  const e = { id: id('exp'), at: new Date().toISOString(), status: 'draft', ...data };
  load().expenses.push(e); save(); return e;
}
export function findSimilarExpenses({ supplier, total, docNumber }) {
  const s = String(supplier || '').toLowerCase();
  return load().expenses.filter((e) =>
    (docNumber && e.docNumber && e.docNumber === docNumber) ||
    (s && String(e.supplier || '').toLowerCase() === s && Math.abs((e.total || 0) - (total || 0)) < 0.01));
}
export function supplierHistory(supplier) {
  const s = String(supplier || '').toLowerCase();
  return load().expenses.filter((e) => String(e.supplier || '').toLowerCase() === s && e.status !== 'rejected');
}
