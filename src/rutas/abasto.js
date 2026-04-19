// src/rutas/abasto.js
import express from 'express';

import { getDb } from '../servicios/db.js';
const router = express.Router();

// ============================================================
// PROVEEDORES
// ============================================================

// Listar proveedores
router.get('/proveedores', (req, res) => {
  const db = getDb();
  try {
    const proveedores = db.prepare(`
      SELECT p.*, 
        COUNT(DISTINCT pa.id) as total_partidas,
        COALESCE(SUM(pa.bultos_disponibles), 0) as bultos_en_stock
      FROM proveedores p
      LEFT JOIN partidas pa ON pa.proveedor_id = p.id AND pa.estado IN ('activa','parcial')
      WHERE p.activo = 1
      GROUP BY p.id
      ORDER BY p.nombre
    `).all();
    res.json({ ok: true, data: proveedores });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Crear proveedor
router.post('/proveedores', (req, res) => {
  const db = getDb();
  const { nombre, razon_social, cuit, telefono, email, direccion, zona, contacto, condicion_pago, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  try {
    const r = db.prepare(`
      INSERT INTO proveedores (nombre, razon_social, cuit, telefono, email, direccion, zona, contacto, condicion_pago, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nombre, razon_social, cuit, telefono, email, direccion, zona, contacto, condicion_pago || 'contado', notas);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Editar proveedor
router.patch('/proveedores/:id', (req, res) => {
  const db = getDb();
  const { nombre, razon_social, cuit, telefono, email, direccion, zona, contacto, condicion_pago, notas } = req.body;
  try {
    db.prepare(`
      UPDATE proveedores SET nombre=?, razon_social=?, cuit=?, telefono=?, email=?,
        direccion=?, zona=?, contacto=?, condicion_pago=?, notas=?
      WHERE id=?
    `).run(nombre, razon_social, cuit, telefono, email, direccion, zona, contacto, condicion_pago, notas, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Desactivar proveedor
router.delete('/proveedores/:id', (req, res) => {
  const db = getDb();
  try {
    db.prepare('UPDATE proveedores SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// PRODUCTOS MAESTRO (retail_productos)
// ============================================================

router.get('/productos', (req, res) => {
  const db = getDb();
  try {
    const productos = db.prepare(`
      SELECT id, nombre, categoria FROM retail_productos
      WHERE activo = 1 OR activo IS NULL
      ORDER BY categoria, nombre
    `).all();
    res.json({ ok: true, data: productos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// PARTIDAS (INGRESO DE STOCK)
// ============================================================

// Listar partidas (con filtros opcionales)
router.get('/partidas', (req, res) => {
  const db = getDb();
  const { estado, proveedor_id, producto, deposito } = req.query;
  let where = [];
  let params = [];
  if (estado) { where.push('pa.estado = ?'); params.push(estado); }
  if (proveedor_id) { where.push('pa.proveedor_id = ?'); params.push(proveedor_id); }
  if (producto) { where.push('(pa.producto LIKE ? OR rp.nombre LIKE ?)'); params.push(`%${producto}%`, `%${producto}%`); }
  if (deposito) { where.push('pa.deposito = ?'); params.push(deposito); }
  const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const partidas = db.prepare(`
      SELECT pa.*,
        pr.nombre as proveedor_nombre,
        rp.nombre as producto_nombre,
        rp.categoria as producto_categoria,
        COALESCE(rp.nombre, pa.producto) as producto_display
      FROM partidas pa
      LEFT JOIN proveedores pr ON pr.id = pa.proveedor_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      ${whereStr}
      ORDER BY pa.fecha_ingreso DESC, pa.id DESC
    `).all(...params);
    res.json({ ok: true, data: partidas });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Detalle de una partida con movimientos
router.get('/partidas/:id', (req, res) => {
  const db = getDb();
  try {
    const partida = db.prepare(`
      SELECT pa.*,
        pr.nombre as proveedor_nombre,
        rp.nombre as producto_nombre,
        rp.categoria as producto_categoria,
        em.nombre as envase_nombre,
        COALESCE(rp.nombre, pa.producto) as producto_display
      FROM partidas pa
      LEFT JOIN proveedores pr ON pr.id = pa.proveedor_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      LEFT JOIN envases_maestro em ON em.id = pa.envase_id
      WHERE pa.id = ?
    `).get(req.params.id);
    if (!partida) return res.status(404).json({ ok: false, error: 'Partida no encontrada' });
    const movimientos = db.prepare(`
      SELECT * FROM movimientos_stock WHERE partida_id = ? ORDER BY fecha DESC
    `).all(req.params.id);
    res.json({ ok: true, data: { ...partida, movimientos } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Crear partida (ingreso de stock)
router.post('/partidas', (req, res) => {
  const db = getDb();
  const {
    fecha_ingreso, producto_id, proveedor_id,
    tipo_ingreso, bultos_ingresados, kilos_por_bulto,
    envase, iva, deposito, costo_por_bulto, notas
  } = req.body;

  if (!producto_id || !bultos_ingresados || !kilos_por_bulto || !tipo_ingreso) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    const prod = db.prepare('SELECT nombre, categoria FROM retail_productos WHERE id=?').get(producto_id);
    if (!prod) return res.status(400).json({ ok: false, error: 'Producto no encontrado en el maestro' });

    const fecha = fecha_ingreso || new Date().toISOString().split('T')[0];

    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO partidas
          (fecha_ingreso, producto, categoria, producto_id, envase, iva, deposito, proveedor_id, tipo_ingreso,
           bultos_ingresados, kilos_por_bulto, bultos_disponibles, costo_por_bulto, moneda, notas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARS', ?)
      `).run(
        fecha, prod.nombre, prod.categoria || null,
        producto_id, envase || null, iva || 'exento',
        deposito || 'MCBA', proveedor_id || null, tipo_ingreso,
        bultos_ingresados, kilos_por_bulto, bultos_ingresados,
        costo_por_bulto || 0, notas || null
      );
      db.prepare(`
        INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, notas)
        VALUES (?, ?, 'ingreso', ?, 'Ingreso inicial')
      `).run(r.lastInsertRowid, fecha, bultos_ingresados);
      return r.lastInsertRowid;
    })();

    res.json({ ok: true, id: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Ajuste de stock manual
router.post('/partidas/:id/ajuste', (req, res) => {
  const db = getDb();
  const { bultos, tipo, notas } = req.body;
  if (!bultos || !tipo) return res.status(400).json({ ok: false, error: 'Faltan campos' });

  try {
    const partida = db.prepare('SELECT * FROM partidas WHERE id=?').get(req.params.id);
    if (!partida) return res.status(404).json({ ok: false, error: 'Partida no encontrada' });

    const delta = tipo === 'salida' ? -Math.abs(bultos) : Math.abs(bultos);
    const nuevosDisponibles = partida.bultos_disponibles + delta;
    if (nuevosDisponibles < 0) return res.status(400).json({ ok: false, error: 'Stock insuficiente' });

    const estadoNuevo = nuevosDisponibles === 0 ? 'cerrada' : nuevosDisponibles < partida.bultos_ingresados ? 'parcial' : 'activa';

    db.transaction(() => {
      db.prepare('UPDATE partidas SET bultos_disponibles=?, estado=? WHERE id=?')
        .run(nuevosDisponibles, estadoNuevo, req.params.id);
      db.prepare('INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, referencia_tipo, notas) VALUES (?,?,?,?,?,?)')
        .run(req.params.id, new Date().toISOString().split('T')[0], 'ajuste', Math.abs(bultos), 'ajuste_manual', notas);
    })();

    res.json({ ok: true, bultos_disponibles: nuevosDisponibles });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// STOCK (vista consolidada)
// ============================================================

router.get('/stock', (req, res) => {
  const db = getDb();
  const { deposito } = req.query;
  try {
    const stock = db.prepare(`
      SELECT
        COALESCE(rp.nombre, pa.producto) as producto,
        COALESCE(rp.categoria, pa.categoria) as categoria,
        pr.nombre as proveedor,
        pa.deposito,
        COUNT(pa.id) as partidas_activas,
        SUM(pa.bultos_disponibles) as bultos_totales,
        AVG(pa.kilos_por_bulto) as kilos_por_bulto_prom,
        SUM(pa.bultos_disponibles * pa.kilos_por_bulto) as kilos_totales,
        AVG(pa.costo_por_bulto) as costo_promedio_bulto,
        MIN(pa.fecha_ingreso) as primer_ingreso,
        MAX(pa.fecha_ingreso) as ultimo_ingreso
      FROM partidas pa
      LEFT JOIN proveedores pr ON pr.id = pa.proveedor_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE pa.estado IN ('activa','parcial') ${deposito ? 'AND pa.deposito = ?' : ''}
      GROUP BY COALESCE(rp.nombre, pa.producto), pa.proveedor_id, pa.deposito
      ORDER BY producto
    `).all(...(deposito ? [deposito] : []));
    res.json({ ok: true, data: stock });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stock por partida (detallado)
router.get('/stock/partidas', (req, res) => {
  const db = getDb();
  const { deposito } = req.query;
  try {
    const stock = db.prepare(`
      SELECT pa.*,
        pr.nombre as proveedor_nombre,
        COALESCE(rp.nombre, pa.producto) as producto_display,
        COALESCE(rp.categoria, pa.categoria) as categoria_display
      FROM partidas pa
      LEFT JOIN proveedores pr ON pr.id = pa.proveedor_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE pa.estado IN ('activa','parcial') ${deposito ? 'AND pa.deposito = ?' : ''}
      ORDER BY producto_display, pa.fecha_ingreso
    `).all(...(deposito ? [deposito] : []));
    res.json({ ok: true, data: stock });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// REMITOS DE SALIDA
// ============================================================

// Listar remitos
router.get('/remitos', (req, res) => {
  const db = getDb();
  const { estado } = req.query;
  try {
    const remitos = db.prepare(`
      SELECT r.*, COUNT(ri.id) as total_items,
        SUM(ri.bultos) as total_bultos
      FROM remitos_salida r
      LEFT JOIN remitos_items ri ON ri.remito_id = r.id
      ${estado ? 'WHERE r.estado = ?' : ''}
      GROUP BY r.id
      ORDER BY r.fecha DESC
    `).all(...(estado ? [estado] : []));
    res.json({ ok: true, data: remitos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Detalle de remito con items
router.get('/remitos/:id', (req, res) => {
  const db = getDb();
  try {
    const remito = db.prepare('SELECT * FROM remitos_salida WHERE id=?').get(req.params.id);
    if (!remito) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });
    const items = db.prepare(`
      SELECT ri.*, pa.proveedor_id, pr.nombre as proveedor_nombre
      FROM remitos_items ri
      JOIN partidas pa ON pa.id = ri.partida_id
      LEFT JOIN proveedores pr ON pr.id = pa.proveedor_id
      WHERE ri.remito_id = ?
    `).all(req.params.id);
    res.json({ ok: true, data: { ...remito, items } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Crear remito
router.post('/remitos', (req, res) => {
  const db = getDb();
  const { fecha, cliente_telefono, empresa, contacto, direccion_entrega, comercial, chofer, tractor, semi, items, notas } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ ok: false, error: 'El remito debe tener al menos un ítem' });

  try {
    // Generar número de remito
    const ultimo = db.prepare("SELECT nro_remito FROM remitos_salida WHERE nro_remito IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    let nroNuevo = 'R-0001';
    if (ultimo) {
      const num = parseInt(ultimo.nro_remito.split('-')[1]) + 1;
      nroNuevo = 'R-' + String(num).padStart(4, '0');
    }

    const result = db.transaction(() => {
      // Validar stock disponible
      for (const item of items) {
        const partida = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);
        if (!partida) throw new Error(`Partida ${item.partida_id} no encontrada`);
        if (partida.bultos_disponibles < item.bultos) throw new Error(`Stock insuficiente en partida de ${partida.producto}`);
      }

      // Crear remito
      const r = db.prepare(`
        INSERT INTO remitos_salida (nro_remito, fecha, cliente_telefono, empresa, contacto, direccion_entrega, comercial, chofer, tractor, semi, estado, notas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitido', ?)
      `).run(nroNuevo, fecha || new Date().toISOString().split('T')[0], cliente_telefono, empresa, contacto, direccion_entrega, comercial, chofer||null, tractor||null, semi||null, notas);

      const remito_id = r.lastInsertRowid;

      // Insertar items y descontar stock
      for (const item of items) {
        const partida = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);

        db.prepare(`
          INSERT INTO remitos_items (remito_id, partida_id, producto, bultos, kilos_por_bulto, precio_ref, precio_final, moneda)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(remito_id, item.partida_id, partida.producto, item.bultos, partida.kilos_por_bulto, item.precio_ref || 0, item.precio_final || 0, item.moneda || 'ARS');

        // Descontar stock
        const nuevosDisp = partida.bultos_disponibles - item.bultos;
        const estadoNuevo = nuevosDisp === 0 ? 'cerrada' : 'parcial';
        db.prepare('UPDATE partidas SET bultos_disponibles=?, estado=? WHERE id=?').run(nuevosDisp, estadoNuevo, item.partida_id);

        // Registrar movimiento
        db.prepare(`
          INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, referencia_tipo, referencia_id, notas)
          VALUES (?, ?, 'salida_remito', ?, 'remito', ?, ?)
        `).run(item.partida_id, fecha, item.bultos, remito_id, `Remito ${nroNuevo}`);
      }

      return { id: remito_id, nro_remito: nroNuevo };
    })();

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// PDF / IMPRESIÓN DE REMITO
// ============================================================

router.get('/remitos/:id/pdf', (req, res) => {
  const db = getDb();
  try {
    const remito = db.prepare(`SELECT * FROM remitos_salida WHERE id = ?`).get(req.params.id);
    if (!remito) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });

    const items = db.prepare(`
      SELECT ri.*,
        COALESCE(rp.nombre, ri.producto) as producto_display,
        pa.deposito, pa.envase, pa.iva
      FROM remitos_items ri
      JOIN partidas pa ON pa.id = ri.partida_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE ri.remito_id = ?
    `).all(req.params.id);

    const fecha = new Date(remito.fecha + 'T12:00:00').toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    // Número formateado tipo "0005 - 00004460"
    const nroParts = (remito.nro_remito || 'R-0001').replace('R-', '');
    const nroFormateado = `0001 - ${nroParts.padStart(8, '0')}`;

    const totalBultos = items.reduce((s, i) => s + i.bultos, 0);
    const totalKilos  = items.reduce((s, i) => s + (i.bultos * i.kilos_por_bulto), 0);

    const rowsHTML = items.map(item => {
      const kilosTotal = (item.bultos * item.kilos_por_bulto).toFixed(1);
      const desc = item.envase
        ? `${item.producto_display.toUpperCase()} ${item.envase.toUpperCase()}`
        : item.producto_display.toUpperCase();
      return `
        <tr>
          <td class="c">${item.bultos}</td>
          <td>${desc}</td>
          <td class="r">${kilosTotal} KG.</td>
        </tr>`;
    }).join('');

    // CAI fijo hasta integrar ARCA
    const CAI     = '51454215726330';
    const CAI_VTO = '11/11/2026';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Remito N° ${nroFormateado}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; background: #f5f5f5; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 8mm 10mm; background: #fff; box-shadow: 0 0 20px rgba(0,0,0,.15); }

  /* ── HEADER ── */
  .hdr { display: flex; align-items: stretch; border: 1px solid #000; margin-bottom: 4px; }
  .hdr-logo { width: 55mm; border-right: 1px solid #000; padding: 8px 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .hdr-logo img { width: 100%; max-width: 130px; height: auto; display: block; margin-bottom: 6px; }
  .logo-sub  { font-size: 9px; font-weight: 700; letter-spacing: .1em; margin: 0 0 5px; text-align:center; }
  .hdr-logo address { font-size: 8px; text-align: center; font-style: normal; line-height: 1.6; color: #333; }
  .hdr-logo .iva-tag { margin-top: 5px; border: 1px solid #000; padding: 1px 6px; font-size: 9px; font-weight: 700; display: inline-block; }

  .hdr-R { width: 24mm; border-right: 1px solid #000; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 6px 4px; gap: 6px; }
  .R-box { border: 3px solid #000; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 900; }
  .R-cod { font-size: 8.5px; text-align: center; font-weight: 600; }

  .hdr-main { flex: 1; padding: 6px 10px; }
  .hdr-main .no-factura { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #555; margin-bottom: 2px; }
  .hdr-main .nro { font-size: 16px; font-weight: 900; letter-spacing: .5px; margin-bottom: 8px; }
  .hdr-main .fecha-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .hdr-main .fecha-label { font-size: 11px; }
  .hdr-main .fecha-val { border: 1px solid #000; padding: 3px 10px; font-size: 12px; font-weight: 700; }
  .hdr-datos { font-size: 8.5px; line-height: 1.7; color: #333; }

  /* ── CLIENTE ── */
  .cli { border: 1px solid #000; border-top: none; padding: 4px 8px; }
  .cli-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
  .cli-label { font-size: 9px; font-weight: 700; white-space: nowrap; min-width: 55px; }
  .cli-val { font-size: 11px; font-weight: 700; border-bottom: 1px solid #000; flex: 1; padding-bottom: 1px; }
  .cli-3col { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 6px; margin-bottom: 2px; }
  .cli-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 2px; }
  .cli-field { display: flex; align-items: baseline; gap: 4px; }
  .cli-field .cli-val { font-size: 10.5px; }

  /* ── TABLA ── */
  .items-table { width: 100%; border-collapse: collapse; border: 1px solid #000; border-top: none; }
  .items-table thead tr { background: #4a4a4a; }
  .items-table thead th { color: #fff; padding: 5px 8px; font-size: 10px; font-weight: 700; }
  .items-table tbody td { padding: 5px 8px; border-bottom: 1px solid #ccc; font-size: 10.5px; vertical-align: middle; }
  .items-table tbody tr:last-child td { border-bottom: none; }
  td.c, th.c { text-align: center; }
  td.r, th.r { text-align: right; }
  .items-table tfoot td { border-top: 2px solid #000; padding: 4px 8px; font-size: 10.5px; font-weight: 700; }

  /* ── CHOFER / OBS ── */
  .extra { border: 1px solid #000; border-top: none; display: grid; grid-template-columns: 1fr 1fr; }
  .chofer-box { border-right: 1px solid #000; padding: 6px 8px; }
  .chofer-box p { font-size: 10px; font-weight: 700; margin-bottom: 3px; }
  .obs-box { padding: 6px 8px; }
  .obs-label { font-size: 9px; font-weight: 700; text-transform: uppercase; margin-bottom: 3px; }
  .obs-lines { border-bottom: 1px solid #999; height: 14px; margin-bottom: 6px; }

  /* ── PIE ── */
  .footer { border: 1px solid #000; border-top: none; display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; }
  .footer-left { font-size: 7.5px; color: #555; line-height: 1.6; }
  .footer-right { text-align: right; }
  .cai-label { font-size: 8px; font-weight: 700; }
  .cai-nro { font-size: 10px; font-weight: 900; letter-spacing: 1px; }
  .cai-vto { font-size: 8px; color: #555; }

  /* barras simuladas */
  .barcode { font-family: 'Libre Barcode 39', monospace; font-size: 28px; letter-spacing: 2px; margin-top: 2px; }

  @media print {
    body { margin: 0; background: #fff; }
    .page { padding: 8mm 10mm; box-shadow: none; }
    .no-print { display: none !important; }
    @page { size: A4; margin: 0; }
  }
</style>
<link href="https://fonts.googleapis.com/css2?family=Libre+Barcode+39&display=swap" rel="stylesheet">
</head>
<body>
<div class="page">

  <!-- BOTÓN IMPRIMIR (se oculta al imprimir) -->
  <div class="no-print" style="text-align:right;margin-bottom:8px">
    <button onclick="window.print()" style="background:#1a3a5c;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:13px;cursor:pointer;font-family:Arial">
      🖨 Imprimir / Guardar PDF
    </button>
  </div>

  <!-- HEADER -->
  <div class="hdr">
    <div class="hdr-logo">
      <img src="/static/logo.jpg" alt="La Niña Bonita">
      <div class="logo-sub">SAN GERÓNIMO S.A.</div>
      <address>
        Independencia 1073 (Este)<br>
        Va. Huarpes | C.P 5425 | Rawson | San Juan<br>
        e-mail: san.geronimo1@gmail.com
      </address>
      <span class="iva-tag">I.V.A. RESPONSABLE INSCRIPTO</span>
    </div>

    <div class="hdr-R">
      <div class="R-box">R</div>
      <div class="R-cod">COD. N° 91</div>
    </div>

    <div class="hdr-main">
      <div class="no-factura">DOCUMENTO NO VALIDO COMO FACTURA</div>
      <div class="nro">N° ${nroFormateado}</div>
      <div class="fecha-row">
        <span class="fecha-label">Fecha</span>
        <span class="fecha-val">${fecha}</span>
      </div>
      <div class="hdr-datos">
        C.U.I.T. N°: 30-67325443-4<br>
        ING. BRUTOS: 9185502940-1<br>
        Fecha Inicio de Actividades: 15/09/1995
      </div>
    </div>
  </div>

  <!-- DATOS CLIENTE -->
  <div class="cli">
    <div class="cli-row">
      <span class="cli-label">Cliente:</span>
      <span class="cli-val">${remito.empresa || ''}</span>
    </div>
    <div class="cli-row">
      <span class="cli-label">Dirección:</span>
      <span class="cli-val">${remito.direccion_entrega || ''}</span>
    </div>
    <div class="cli-2col">
      <div class="cli-field"><span class="cli-label">Localidad:</span><span class="cli-val">${''}</span></div>
      <div class="cli-field"><span class="cli-label">CP:</span><span class="cli-val">${''}</span></div>
    </div>
    <div class="cli-2col">
      <div class="cli-field"><span class="cli-label">IVA</span><span class="cli-val">${''}</span></div>
      <div class="cli-field"><span class="cli-label">CUIT</span><span class="cli-val">${''}</span></div>
    </div>
    <div class="cli-row">
      <span class="cli-label">Condiciones de Venta:</span>
      <span class="cli-val" style="font-size:10px">${''}</span>
      <span class="cli-label" style="margin-left:20px">Factura N°</span>
      <span class="cli-val">${''}</span>
    </div>
  </div>

  <!-- TABLA ITEMS -->
  <table class="items-table">
    <thead>
      <tr>
        <th class="c" style="width:50px">Cant.</th>
        <th style="text-align:left">Artículo</th>
        <th class="r" style="width:80px">KG.</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHTML}
      <!-- filas vacías para dar espacio -->
      ${'<tr><td style="height:22px"></td><td></td><td></td></tr>'.repeat(Math.max(0, 8 - items.length))}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="text-align:right">SUB TOTAL</td>
        <td class="r">${totalKilos.toFixed(1)} KG.</td>
      </tr>
    </tfoot>
  </table>

  <!-- CHOFER + OBSERVACIONES -->
  <div class="extra">
    <div class="chofer-box">
      <p>CHOFER: ${remito.chofer || ''}</p>
      <p>TRACTOR: ${remito.tractor || ''}</p>
      <p>SEMI: ${remito.semi || ''}</p>
    </div>
    <div class="obs-box">
      <div class="obs-label">Observaciones:</div>
      ${remito.notas
        ? `<div style="font-size:10px;line-height:1.6;margin-bottom:4px">${remito.notas}</div>`
        : `<div class="obs-lines"></div><div class="obs-lines"></div><div class="obs-lines"></div>`
      }
    </div>
  </div>

  <!-- PIE / CAI -->
  <div class="footer">
    <div class="footer-left">
      Impreso en AG Diseño e Impresiones<br>
      B° Parque Sur casa 5 Mza 8 | Cál.: 2644002300 - C.P 5425<br>
      CUIT: 27-25639792-3 del 005-00004001 al 00004500<br>
      Original: Blanco | Dupl.: Color | Trip.: Color
    </div>
    <div class="footer-right">
      <div class="cai-label">C.A.I N°</div>
      <div class="cai-nro">${CAI}</div>
      <div class="cai-vto">Vto: ${CAI_VTO}</div>
      <div class="barcode">*${CAI}*</div>
    </div>
  </div>

</div>
<script>
  // Auto-print solo si se abre directamente
  if (window.location.search.indexOf('autoprint') >= 0) window.onload = function(){ window.print(); };
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});




// Anular remito (devuelve stock, mantiene número)
router.post('/remitos/:id/anular', (req, res) => {
  const db = getDb();
  try {
    const remito = db.prepare('SELECT * FROM remitos_salida WHERE id=?').get(req.params.id);
    if (!remito) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });
    if (remito.estado === 'anulado') return res.status(400).json({ ok: false, error: 'Ya está anulado' });
    if (remito.estado === 'facturado') return res.status(400).json({ ok: false, error: 'No se puede anular un remito facturado' });

    const items = db.prepare('SELECT * FROM remitos_items WHERE remito_id=?').all(req.params.id);

    db.transaction(() => {
      // Devolver stock a cada partida
      for (const item of items) {
        const partida = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);
        if (!partida) continue;
        const nuevosDisp = partida.bultos_disponibles + item.bultos;
        const estadoNuevo = nuevosDisp >= partida.bultos_ingresados ? 'activa' : 'parcial';
        db.prepare('UPDATE partidas SET bultos_disponibles=?, estado=? WHERE id=?')
          .run(nuevosDisp, estadoNuevo, item.partida_id);
        // Registrar movimiento de devolución
        db.prepare(`
          INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, referencia_tipo, referencia_id, notas)
          VALUES (?, date('now','localtime'), 'devolucion', ?, 'remito', ?, ?)
        `).run(item.partida_id, item.bultos, remito.id, `Anulación remito ${remito.nro_remito}`);
      }
      // Marcar como anulado — el número queda en la DB como constancia
      db.prepare("UPDATE remitos_salida SET estado='anulado' WHERE id=?").run(req.params.id);
    })();

    res.json({ ok: true, mensaje: `Remito ${remito.nro_remito} anulado. Stock devuelto.` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Enviar remito por WhatsApp al cliente
router.post('/remitos/:id/whatsapp', async (req, res) => {
  const db = getDb();
  try {
    const remito = db.prepare('SELECT * FROM remitos_salida WHERE id=?').get(req.params.id);
    if (!remito) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });

    const telefono = req.body.telefono || remito.cliente_telefono;
    if (!telefono) return res.status(400).json({ ok: false, error: 'Se requiere número de WhatsApp del cliente' });

    const baseUrl = process.env.BASE_URL || `https://agente-lnbonita1-production.up.railway.app`;
    const pdfUrl = `${baseUrl}/api/abasto/remitos/${remito.id}/pdf`;

    const mensaje = `🧾 *Remito ${remito.nro_remito}*\n` +
      `Fecha: ${remito.fecha}\n` +
      `Cliente: ${remito.empresa || '-'}\n\n` +
      `Podés ver el remito en el siguiente link:\n${pdfUrl}\n\n` +
      `_La Niña Bonita — San Gerónimo SA_`;

    // Enviar via Twilio
    const twilio = await import('twilio');
    const client = twilio.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const telFormato = telefono.startsWith('+') ? telefono : '+54' + telefono.replace(/^0/, '');

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${telFormato}`,
      body: mensaje
    });

    // Marcar como enviado
    db.prepare('UPDATE remitos_salida SET whatsapp_enviado=1 WHERE id=?').run(req.params.id);

    res.json({ ok: true, mensaje: `Remito enviado a ${telFormato}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Subir remito conformado (imagen/PDF)
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const multer = _require('multer');
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';

const _dirname = dirname(_fileURLToPath(import.meta.url));
const uploadDir = join(_dirname, '../../data/conformados');
try { mkdirSync(uploadDir, { recursive: true }); } catch(e) {}

const storageConformado = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `remito-${req.params.id}-conformado.${ext}`);
  }
});
const uploadConformado = multer({ storage: storageConformado, limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/remitos/:id/conformado', uploadConformado.single('archivo'), (req, res) => {
  const db = getDb();
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });
    const path = `/data/conformados/${req.file.filename}`;
    db.prepare('UPDATE remitos_salida SET conformado_path=? WHERE id=?').run(path, req.params.id);
    res.json({ ok: true, path });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Ver conformado
router.get('/remitos/:id/conformado', (req, res) => {
  const db = getDb();
  try {
    const r = db.prepare('SELECT conformado_path FROM remitos_salida WHERE id=?').get(req.params.id);
    if (!r?.conformado_path) return res.status(404).json({ ok: false, error: 'Sin conformado' });
    res.json({ ok: true, path: r.conformado_path });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/gastos', (req, res) => {
  const db = getDb();
  try {
    const gastos = db.prepare(`
      SELECT g.*, pa.producto as partida_producto
      FROM gastos g
      LEFT JOIN partidas pa ON pa.id = g.partida_id
      ORDER BY g.fecha DESC
    `).all();
    res.json({ ok: true, data: gastos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/gastos', (req, res) => {
  const db = getDb();
  const { fecha, tipo, partida_id, concepto, importe, moneda, notas } = req.body;
  if (!concepto || !importe) return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  try {
    const r = db.prepare(`
      INSERT INTO gastos (fecha, tipo, partida_id, concepto, importe, moneda, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fecha || new Date().toISOString().split('T')[0], tipo || 'general', partida_id || null, concepto, importe, moneda || 'ARS', notas);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// RESUMEN ABASTO (dashboard)
// ============================================================

router.get('/resumen', (req, res) => {
  const db = getDb();
  try {
    const stockTotal = db.prepare(`
      SELECT COUNT(*) as partidas, SUM(bultos_disponibles) as bultos, SUM(kilos_disponibles) as kilos
      FROM partidas WHERE estado IN ('activa','parcial')
    `).get();

    const remitosHoy = db.prepare(`
      SELECT COUNT(*) as total FROM remitos_salida
      WHERE fecha = date('now','localtime') AND estado != 'anulado'
    `).get();

    const remitosEmitidos = db.prepare(`
      SELECT COUNT(*) as total FROM remitos_salida WHERE estado = 'emitido'
    `).get();

    const productos = db.prepare(`
      SELECT COALESCE(rp.nombre, pa.producto) as producto, SUM(pa.bultos_disponibles) as bultos
      FROM partidas pa
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE pa.estado IN ('activa','parcial')
      GROUP BY COALESCE(rp.nombre, pa.producto) ORDER BY bultos DESC LIMIT 10
    `).all();

    res.json({ ok: true, data: { stockTotal, remitosHoy, remitosEmitidos, topProductos: productos } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// ETIQUETAS — Config por producto retail
// ============================================================

// Buscar producto retail por nombre (para cargar config al etiquetar)
router.get('/etiqueta/producto', (req, res) => {
  const db = getDb();
  const { nombre } = req.query;
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  try {
    // Buscar por similitud en nombre
    const rp = db.prepare(`
      SELECT rp.id, rp.nombre, rp.etiqueta_ancho, rp.etiqueta_alto, rp.etiqueta_campos,
        GROUP_CONCAT(re.supermercado || ':' || re.ean) as eans
      FROM retail_productos rp
      LEFT JOIN retail_eans re ON re.retail_producto_id = rp.id
      WHERE LOWER(rp.nombre) LIKE LOWER(?)
      GROUP BY rp.id
      LIMIT 1
    `).get('%' + nombre.trim() + '%');

    if (!rp) return res.json({ ok: false, error: 'Producto no encontrado' });

    // Parsear EANs a objeto
    const eans = {};
    if (rp.eans) {
      rp.eans.split(',').forEach(pair => {
        const [sup, ean] = pair.split(':');
        if (sup && ean) eans[sup] = ean;
      });
    }

    res.json({
      ok: true,
      data: {
        id: rp.id,
        nombre: rp.nombre,
        etiqueta_ancho: rp.etiqueta_ancho || 100,
        etiqueta_alto: rp.etiqueta_alto || 150,
        etiqueta_campos: JSON.parse(rp.etiqueta_campos || '["logo","producto","ean","kilos","bulto_nro","cliente","fecha"]'),
        eans
      }
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Guardar config de etiqueta en producto retail
router.patch('/etiqueta/producto/:id', (req, res) => {
  const db = getDb();
  const { etiqueta_ancho, etiqueta_alto, etiqueta_campos } = req.body;
  try {
    const cols = db.prepare("PRAGMA table_info(retail_productos)").all().map(c => c.name);
    // Asegurarse que las columnas existen
    if (!cols.includes('etiqueta_ancho')) {
      db.exec("ALTER TABLE retail_productos ADD COLUMN etiqueta_ancho INTEGER DEFAULT 100");
      db.exec("ALTER TABLE retail_productos ADD COLUMN etiqueta_alto INTEGER DEFAULT 150");
      db.exec("ALTER TABLE retail_productos ADD COLUMN etiqueta_campos TEXT");
    }
    db.prepare(`
      UPDATE retail_productos 
      SET etiqueta_ancho=?, etiqueta_alto=?, etiqueta_campos=?
      WHERE id=?
    `).run(
      etiqueta_ancho || 100,
      etiqueta_alto || 150,
      typeof etiqueta_campos === 'string' ? etiqueta_campos : JSON.stringify(etiqueta_campos || []),
      req.params.id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ============================================================
// MANDATA
// ============================================================

// Listar mandatas
router.get('/mandatas', (req, res) => {
  const db = getDb();
  const { estado, deposito } = req.query;
  let where = [];
  let params = [];
  if (estado) { where.push('m.estado = ?'); params.push(estado); }
  if (deposito) { where.push('m.deposito = ?'); params.push(deposito); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const mandatas = db.prepare(`
      SELECT m.*, COUNT(mi.id) as total_items
      FROM mandatas m
      LEFT JOIN mandatas_items mi ON mi.mandata_id = m.id
      ${w}
      GROUP BY m.id
      ORDER BY m.fecha DESC, m.id DESC
    `).all(...params);
    res.json({ ok: true, data: mandatas });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Detalle mandata
router.get('/mandatas/:id', (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare('SELECT * FROM mandatas WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const items = db.prepare(`
      SELECT mi.*, pa.deposito, pa.envase,
        COALESCE(rp.nombre, mi.producto) as producto_display
      FROM mandatas_items mi
      JOIN partidas pa ON pa.id = mi.partida_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE mi.mandata_id = ?
    `).all(req.params.id);
    res.json({ ok: true, data: { ...m, items } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Crear mandata (descuenta stock inmediatamente)
router.post('/mandatas', (req, res) => {
  const db = getDb();
  const { fecha, deposito, empresa, contacto, cliente_telefono, comercial, items, notas } = req.body;
  if (!items || !items.length) return res.status(400).json({ ok: false, error: 'Sin items' });
  if (!empresa) return res.status(400).json({ ok: false, error: 'Cliente requerido' });

  try {
    // Generar número
    const ultimo = db.prepare("SELECT nro_mandata FROM mandatas ORDER BY id DESC LIMIT 1").get();
    let nroNuevo = 'M-0001';
    if (ultimo?.nro_mandata) {
      const num = parseInt(ultimo.nro_mandata.split('-')[1]) + 1;
      nroNuevo = 'M-' + String(num).padStart(4, '0');
    }

    const result = db.transaction(() => {
      // Validar stock
      for (const item of items) {
        const p = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);
        if (!p) throw new Error(`Partida ${item.partida_id} no encontrada`);
        if (p.bultos_disponibles < item.bultos) throw new Error(`Stock insuficiente: ${p.producto} (disp: ${p.bultos_disponibles})`);
      }

      // Calcular totales
      let total_kg = 0, total_importe = 0;
      for (const item of items) {
        const kg = item.bultos * item.kilos_por_bulto;
        total_kg += kg;
        total_importe += kg * (item.precio_kg || 0);
      }

      // Crear mandata
      const r = db.prepare(`
        INSERT INTO mandatas (nro_mandata, fecha, deposito, empresa, contacto, cliente_telefono, comercial, estado, total_kg, total_importe, notas)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)
      `).run(nroNuevo, fecha || new Date().toISOString().split('T')[0],
        deposito || 'MCBA', empresa, contacto || null, cliente_telefono || null,
        comercial || null, total_kg, total_importe, notas || null);

      const mandata_id = r.lastInsertRowid;

      // Insertar items y descontar stock
      for (const item of items) {
        const p = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);
        const kg_total = item.bultos * item.kilos_por_bulto;
        const importe = kg_total * (item.precio_kg || 0);

        db.prepare(`
          INSERT INTO mandatas_items (mandata_id, partida_id, producto, bultos, kilos_por_bulto, kilos_total, precio_kg, importe)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(mandata_id, item.partida_id, p.producto, item.bultos, item.kilos_por_bulto, kg_total, item.precio_kg || 0, importe);

        // Descontar stock
        const nuevosDisp = p.bultos_disponibles - item.bultos;
        const estadoP = nuevosDisp === 0 ? 'cerrada' : 'parcial';
        db.prepare('UPDATE partidas SET bultos_disponibles=?, estado=? WHERE id=?').run(nuevosDisp, estadoP, item.partida_id);

        // Registrar movimiento
        db.prepare(`
          INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, referencia_tipo, referencia_id, notas)
          VALUES (?, ?, 'salida_factura', ?, 'mandata', ?, ?)
        `).run(item.partida_id, fecha || new Date().toISOString().split('T')[0], item.bultos, mandata_id, `Mandata ${nroNuevo}`);
      }

      return { id: mandata_id, nro_mandata: nroNuevo };
    })();

    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Anular mandata (devuelve stock)
router.post('/mandatas/:id/anular', (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare('SELECT * FROM mandatas WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (m.estado === 'facturada') return res.status(400).json({ ok: false, error: 'No se puede anular una mandata ya facturada' });

    const items = db.prepare('SELECT * FROM mandatas_items WHERE mandata_id=?').all(req.params.id);

    db.transaction(() => {
      // Devolver stock
      for (const item of items) {
        const p = db.prepare('SELECT * FROM partidas WHERE id=?').get(item.partida_id);
        if (!p) continue;
        const nuevosDisp = p.bultos_disponibles + item.bultos;
        const estadoP = nuevosDisp >= p.bultos_ingresados ? 'activa' : 'parcial';
        db.prepare('UPDATE partidas SET bultos_disponibles=?, estado=? WHERE id=?').run(nuevosDisp, estadoP, item.partida_id);
        db.prepare(`
          INSERT INTO movimientos_stock (partida_id, fecha, tipo, bultos, referencia_tipo, referencia_id, notas)
          VALUES (?, ?, 'devolucion', ?, 'mandata', ?, 'Anulación mandata')
        `).run(item.partida_id, new Date().toISOString().split('T')[0], item.bultos, m.id);
      }
      db.prepare("UPDATE mandatas SET estado='anulada' WHERE id=?").run(req.params.id);
    })();

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PDF de mandata
router.get('/mandatas/:id/pdf', (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare('SELECT * FROM mandatas WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'No encontrada' });

    const items = db.prepare(`
      SELECT mi.*, COALESCE(rp.nombre, mi.producto) as producto_display, pa.envase
      FROM mandatas_items mi
      JOIN partidas pa ON pa.id = mi.partida_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE mi.mandata_id = ?
    `).all(req.params.id);

    const fecha = new Date(m.fecha + 'T12:00:00').toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });

    const rowsHTML = items.map(item => `
      <tr>
        <td class="c">${item.bultos}</td>
        <td>${item.producto_display.toUpperCase()}${item.envase ? ' ' + item.envase.toUpperCase() : ''}</td>
        <td class="r">${item.kilos_total.toFixed(1)} kg</td>
        <td class="r">${item.precio_kg > 0 ? '$' + item.precio_kg.toLocaleString('es-AR', {minimumFractionDigits:2}) : '—'}</td>
        <td class="r">${item.importe > 0 ? '$' + item.importe.toLocaleString('es-AR', {minimumFractionDigits:2}) : '—'}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Mandata ${m.nro_mandata}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#000;background:#fff}
.page{width:210mm;margin:0 auto;padding:6mm 8mm}
.hdr{display:flex;align-items:stretch;border:1px solid #000;margin-bottom:4px}
.hdr-logo{width:44mm;border-right:1px solid #000;padding:6px 8px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.logo-name{font-size:20px;font-weight:900;font-style:italic;color:#b8002a;letter-spacing:-1px;line-height:1}
.logo-sub{font-size:9px;font-weight:700;letter-spacing:.1em;margin:2px 0 6px}
.hdr-logo address{font-size:8px;text-align:center;font-style:normal;line-height:1.5;color:#333}
.hdr-M{width:20mm;border-right:1px solid #000;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4px}
.M-box{border:3px solid #b8002a;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#b8002a;margin-bottom:3px}
.hdr-main{flex:1;padding:6px 10px}
.no-fiscal{font-size:9px;font-weight:700;text-transform:uppercase;color:#b8002a;margin-bottom:2px}
.nro{font-size:16px;font-weight:900;margin-bottom:6px}
.fecha-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.fecha-val{border:1px solid #000;padding:3px 10px;font-size:12px;font-weight:700}
.hdr-datos{font-size:8.5px;line-height:1.7;color:#333}
.cli{border:1px solid #000;border-top:none;padding:5px 8px}
.cli-row{display:flex;align-items:baseline;gap:6px;margin-bottom:3px}
.cli-label{font-size:9px;font-weight:700;white-space:nowrap;min-width:65px}
.cli-val{font-size:11px;font-weight:700;border-bottom:1px solid #000;flex:1;padding-bottom:1px}
.dep-badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:10px;font-weight:700;background:#dbeafe;color:#1e40af;margin-left:8px}
table{width:100%;border-collapse:collapse;border:1px solid #000;border-top:none}
thead tr{background:#0f2540}
thead th{color:#fff;padding:6px 8px;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em}
tbody td{padding:6px 8px;border-bottom:1px solid #ddd;font-size:10.5px}
tbody tr:last-child td{border-bottom:none}
tfoot td{border-top:2px solid #000;padding:5px 8px;font-weight:700;font-size:11px}
td.c,th.c{text-align:center}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.footer{border:1px solid #000;border-top:none;display:flex;justify-content:space-between;align-items:center;padding:5px 8px}
.footer-left{font-size:8px;color:#555;line-height:1.6}
.footer-right{font-size:9px;font-weight:700;color:#b8002a;text-align:right}
.estado-badge{display:inline-block;padding:2px 8px;border-radius:4px;background:#fef9c3;color:#854d0e;font-size:9px;font-weight:700;text-transform:uppercase;margin-left:6px}
@media print{.no-print{display:none!important}.page{padding:4mm 6mm}}
</style></head><body><div class="page">
<div class="no-print" style="text-align:right;margin-bottom:8px">
  <button onclick="window.print()" style="background:#1a3a5c;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:13px;cursor:pointer">🖨 Imprimir</button>
</div>
<div class="hdr">
  <div class="hdr-logo">
    <div class="logo-name">La Niña<br>Bonita</div>
    <div class="logo-sub">SAN GERÓNIMO S.A.</div>
    <address>Independencia 1073 (Este)<br>Va. Huarpes | C.P 5425 | Rawson | San Juan</address>
  </div>
  <div class="hdr-M"><div class="M-box">M</div><div style="font-size:8px;text-align:center">MANDATA</div></div>
  <div class="hdr-main">
    <div class="no-fiscal">⚠ DOCUMENTO INTERNO — NO VÁLIDO COMO FACTURA</div>
    <div class="nro">${m.nro_mandata} <span class="estado-badge">${m.estado.toUpperCase()}</span></div>
    <div class="fecha-row"><span style="font-size:11px">Fecha</span><span class="fecha-val">${fecha}</span></div>
    <div class="hdr-datos">C.U.I.T.: 30-67325443-4 &nbsp;·&nbsp; IVA Responsable Inscripto<br>Depósito: <strong>${m.deposito}</strong> &nbsp;·&nbsp; Comercial: ${m.comercial || '—'}</div>
  </div>
</div>
<div class="cli">
  <div class="cli-row"><span class="cli-label">Cliente:</span><span class="cli-val">${m.empresa || '—'}</span></div>
  ${m.contacto ? `<div class="cli-row"><span class="cli-label">Contacto:</span><span class="cli-val">${m.contacto}</span></div>` : ''}
  ${m.notas ? `<div class="cli-row"><span class="cli-label">Notas:</span><span class="cli-val" style="font-weight:400">${m.notas}</span></div>` : ''}
</div>
<table>
  <thead><tr><th class="c" style="width:50px">Bultos</th><th style="text-align:left">Producto</th><th class="r" style="width:75px">Kg total</th><th class="r" style="width:80px">$/kg</th><th class="r" style="width:90px">Importe</th></tr></thead>
  <tbody>${rowsHTML}${'<tr><td style="height:20px"></td><td></td><td></td><td></td><td></td></tr>'.repeat(Math.max(0, 6 - items.length))}</tbody>
  <tfoot>
    <tr>
      <td colspan="2" style="text-align:right">TOTAL</td>
      <td class="r">${m.total_kg.toFixed(1)} kg</td>
      <td></td>
      <td class="r">$${m.total_importe.toLocaleString('es-AR', {minimumFractionDigits:2})}</td>
    </tr>
  </tfoot>
</table>
<div class="footer">
  <div class="footer-left">San Gerónimo SA · CUIT 30-67325443-4 · Documento generado el ${new Date().toLocaleString('es-AR')}</div>
  <div class="footer-right">${m.nro_mandata} — PENDIENTE DE FACTURACIÓN</div>
</div>
</div></body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;

