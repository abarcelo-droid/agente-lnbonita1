// src/rutas/_etlClientesSg.js
// ── ENDPOINT ADMIN TEMPORAL #401 Paso 4 — backup → reset(sg_clientes) → run → verify ──
// Admin-only. Mismo patrón seguro que el ETL de proveedores. REMOVER tras verificar.
//   GET  /api/admin/_etl-clientes/verify           → conteo sg_clientes (esperado 545)
//   GET  /api/admin/_etl-clientes/backup           → db.backup() online (WAL-safe)
//   GET  /api/admin/_etl-clientes/backup/download   → descarga off-box
//   POST /api/admin/_etl-clientes/reset?confirmo=SI → vacía SOLO sg_clientes (exige backup)
//   POST /api/admin/_etl-clientes/run?confirmo=SI   → inserta el payload (exige backup + vacío)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath } from '../servicios/db.js';
import { runEtlClientes, getClientesCount } from '../servicios/etlClientesSg.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = path.join(__dir, '../servicios/etlClientesSgPayload.json');
const BACKUP_PREFIX = 'backup-pre-clientes-';
const router = express.Router();

router.use((req, res, next) => {
  try { const c = req.cookies?.lnb_user; if (c) req.user = JSON.parse(c); } catch (_) {}
  next();
});
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
  next();
};
const backupDir = () => path.dirname(dbPath);
const listBackups = () => { try { return fs.readdirSync(backupDir()).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db')); } catch { return []; } };

router.get('/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, sg_clientes: getClientesCount(getDb()), esperado: 545 });
});

router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${BACKUP_PREFIX}${stamp}.db`;
    const dest = path.join(backupDir(), file);
    await getDb().backup(dest);
    const sizeBytes = fs.statSync(dest).size;
    res.json({ ok: true, file, ruta: dest, sizeBytes, sizeMB: +(sizeBytes / 1048576).toFixed(1),
      downloadUrl: `/api/admin/_etl-clientes/backup/download?file=${encodeURIComponent(file)}` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/backup/download', requireAdmin, (req, res) => {
  const file = String(req.query.file || '');
  if (!/^backup-pre-clientes-[\w.\-]+\.db$/.test(file)) return res.status(400).json({ ok: false, error: 'Nombre inválido' });
  const full = path.join(backupDir(), file);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'No existe' });
  res.download(full);
});

// RESET solo sg_clientes (las tablas de ventas que la referencian están vacías → sin FK rota)
router.post('/reset', requireAdmin, (req, res) => {
  if (String(req.query.confirmo) !== 'SI') return res.status(400).json({ ok: false, error: 'Falta ?confirmo=SI' });
  if (listBackups().length === 0) return res.status(400).json({ ok: false, error: 'No hay backup previo. Hacé GET /backup primero.' });
  const db = getDb();
  const before = getClientesCount(db);
  try {
    const deleted = db.prepare('DELETE FROM sg_clientes').run().changes;
    res.json({ ok: true, tabla: 'sg_clientes', before, deleted, preservado: ['sg_proveedores', 'sg_cliente_categorias', 'ventas SG (sg_ven_*)', 'ifco_*', 'catálogo/contable'] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/run', requireAdmin, (req, res) => {
  if (String(req.query.confirmo) !== 'SI') return res.status(400).json({ ok: false, error: 'Falta ?confirmo=SI' });
  if (listBackups().length === 0) return res.status(400).json({ ok: false, error: 'No hay backup previo. Hacé GET /backup primero.' });
  let payload;
  try { payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8')); }
  catch (e) { return res.status(500).json({ ok: false, error: 'No se pudo leer el payload: ' + e.message }); }
  try {
    const r = runEtlClientes(getDb(), payload);
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message, stack: e.stack }); }
});

export default router;
