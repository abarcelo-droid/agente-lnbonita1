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
  const { fecha, cliente_telefono, empresa, contacto, direccion_entrega, comercial, items, notas } = req.body;
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
        INSERT INTO remitos_salida (nro_remito, fecha, cliente_telefono, empresa, contacto, direccion_entrega, comercial, estado, notas)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'emitido', ?)
      `).run(nroNuevo, fecha || new Date().toISOString().split('T')[0], cliente_telefono, empresa, contacto, direccion_entrega, comercial, notas);

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
    const remito = db.prepare(`
      SELECT * FROM remitos_salida WHERE id = ?
    `).get(req.params.id);
    if (!remito) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });

    const items = db.prepare(`
      SELECT ri.*, 
        COALESCE(rp.nombre, ri.producto) as producto_display,
        COALESCE(rp.categoria, pa.categoria) as categoria,
        pa.deposito,
        pa.envase,
        pa.iva
      FROM remitos_items ri
      JOIN partidas pa ON pa.id = ri.partida_id
      LEFT JOIN retail_productos rp ON rp.id = pa.producto_id
      WHERE ri.remito_id = ?
    `).all(req.params.id);

    const fecha = new Date(remito.fecha + 'T12:00:00').toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const totalBultos = items.reduce((s, i) => s + i.bultos, 0);
    const totalKilos = items.reduce((s, i) => s + (i.bultos * i.kilos_por_bulto), 0);
    const totalImporte = items.reduce((s, i) => s + (i.precio_final > 0 ? i.bultos * i.precio_final : 0), 0);

    const rowsHTML = items.map((item, idx) => {
      const kilosTotal = (item.bultos * item.kilos_por_bulto).toFixed(1);
      const precioStr = item.precio_final > 0
        ? '$' + item.precio_final.toLocaleString('es-AR', { minimumFractionDigits: 2 })
        : '—';
      const importeStr = item.precio_final > 0
        ? '$' + (item.bultos * item.precio_final).toLocaleString('es-AR', { minimumFractionDigits: 2 })
        : '—';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td><strong>${item.producto_display}</strong>${item.envase ? `<br><span class="det">${item.envase}</span>` : ''}</td>
          <td class="c">${item.deposito || 'MCBA'}</td>
          <td class="r">${item.bultos}</td>
          <td class="r">${item.kilos_por_bulto} kg</td>
          <td class="r">${kilosTotal} kg</td>
          <td class="r">${precioStr}</td>
          <td class="r">${importeStr}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Remito ${remito.nro_remito}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Arial', sans-serif; font-size: 11px; color: #1a2332; background: #fff; }

  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 14mm; }

  /* HEADER */
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1a3a5c; padding-bottom: 10px; margin-bottom: 12px; }
  .header-left .company { font-size: 18px; font-weight: 800; color: #0f2540; letter-spacing: -.3px; }
  .header-left .company-sub { font-size: 10px; color: #5a6a7e; margin-top: 2px; }
  .header-right { text-align: right; }
  .remito-box { border: 2px solid #1a3a5c; border-radius: 6px; padding: 8px 14px; display: inline-block; }
  .remito-label { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: #5a6a7e; }
  .remito-nro { font-size: 20px; font-weight: 800; color: #1a3a5c; }
  .remito-fecha { font-size: 10px; color: #5a6a7e; margin-top: 2px; }

  /* DATOS */
  .datos-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .datos-box { border: 1px solid #dde3ea; border-radius: 6px; padding: 8px 10px; }
  .datos-box-title { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #8a9bb0; margin-bottom: 5px; }
  .datos-box p { font-size: 10.5px; color: #1a2332; margin-bottom: 2px; }
  .datos-box strong { color: #0f2540; }

  /* TABLA */
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  thead tr { background: #0f2540; }
  thead th { color: #fff; padding: 7px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  tbody tr:nth-child(even) { background: #f0f4f8; }
  tbody tr:last-child td { border-bottom: 2px solid #1a3a5c; }
  td { padding: 7px 8px; border-bottom: 1px solid #dde3ea; font-size: 10.5px; vertical-align: middle; }
  td.r { text-align: right; font-variant-numeric: tabular-nums; }
  td.c { text-align: center; }
  td .det { font-size: 9px; color: #5a6a7e; }

  /* TOTALES */
  .totales { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .totales-box { border: 1px solid #dde3ea; border-radius: 6px; overflow: hidden; min-width: 220px; }
  .totales-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 10.5px; border-bottom: 1px solid #dde3ea; }
  .totales-row:last-child { border-bottom: none; background: #0f2540; color: #fff; font-weight: 700; font-size: 11px; }
  .totales-row span:first-child { color: inherit; opacity: .8; }

  /* FIRMAS */
  .firmas { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 30px; }
  .firma-box { text-align: center; }
  .firma-line { border-top: 1px solid #1a2332; padding-top: 5px; font-size: 9px; color: #5a6a7e; text-transform: uppercase; letter-spacing: .06em; }

  /* PIE */
  .footer { margin-top: 20px; border-top: 1px solid #dde3ea; padding-top: 8px; display: flex; justify-content: space-between; align-items: center; }
  .footer-left { font-size: 9px; color: #8a9bb0; }
  .footer-right { font-size: 9px; color: #8a9bb0; text-align: right; }

  /* BADGE ESTADO */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .badge-mcba { background: #dbeafe; color: #1e40af; }
  .badge-finca { background: #dcfce7; color: #166534; }
  .badge-sanpedro { background: #fef9c3; color: #854d0e; }

  @media print {
    body { margin: 0; }
    .page { padding: 8mm 10mm; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <div class="company">SAN GERONIMO SA</div>
      <div class="company-sub">CUIT: 30-67325443-4 &nbsp;·&nbsp; IVA Inscripto &nbsp;·&nbsp; Barrio Rawson, San Juan</div>
    </div>
    <div class="header-right">
      <div class="remito-box">
        <div class="remito-label">Remito</div>
        <div class="remito-nro">${remito.nro_remito}</div>
        <div class="remito-fecha">Fecha: ${fecha}</div>
      </div>
    </div>
  </div>

  <!-- DATOS CLIENTE Y ENTREGA -->
  <div class="datos-grid">
    <div class="datos-box">
      <div class="datos-box-title">Destinatario</div>
      <p><strong>${remito.empresa || '—'}</strong></p>
      ${remito.contacto ? `<p>${remito.contacto}</p>` : ''}
      ${remito.direccion_entrega ? `<p>📍 ${remito.direccion_entrega}</p>` : ''}
    </div>
    <div class="datos-box">
      <div class="datos-box-title">Datos del remito</div>
      <p><strong>Comercial:</strong> ${remito.comercial || '—'}</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Estado:</strong> ${remito.estado}</p>
      ${remito.notas ? `<p><strong>Notas:</strong> ${remito.notas}</p>` : ''}
    </div>
  </div>

  <!-- TABLA PRODUCTOS -->
  <table>
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th style="text-align:left">Producto</th>
        <th style="width:60px">Depósito</th>
        <th style="width:55px;text-align:right">Bultos</th>
        <th style="width:60px;text-align:right">Kg/bulto</th>
        <th style="width:65px;text-align:right">Kg total</th>
        <th style="width:75px;text-align:right">Precio</th>
        <th style="width:80px;text-align:right">Importe</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHTML}
    </tbody>
  </table>

  <!-- TOTALES -->
  <div class="totales">
    <div class="totales-box">
      <div class="totales-row"><span>Total bultos</span><span><strong>${totalBultos}</strong></span></div>
      <div class="totales-row"><span>Total kilos</span><span><strong>${totalKilos.toFixed(1)} kg</strong></span></div>
      ${totalImporte > 0 ? `<div class="totales-row"><span>Total importe</span><span><strong>$${totalImporte.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</strong></span></div>` : ''}
    </div>
  </div>

  <!-- FIRMAS -->
  <div class="firmas">
    <div class="firma-box">
      <br><br><br>
      <div class="firma-line">Firma y aclaración emisor</div>
    </div>
    <div class="firma-box">
      <br><br><br>
      <div class="firma-line">Firma y aclaración transportista</div>
    </div>
    <div class="firma-box">
      <br><br><br>
      <div class="firma-line">Firma y aclaración receptor</div>
    </div>
  </div>

  <!-- PIE -->
  <div class="footer">
    <div class="footer-left">
      San Geronimo SA &nbsp;·&nbsp; CUIT 30-67325443-4 &nbsp;·&nbsp; IVA Inscripto<br>
      Documento generado el ${new Date().toLocaleString('es-AR')}
    </div>
    <div class="footer-right">
      ${remito.nro_remito}<br>
      Página 1 de 1
    </div>
  </div>

</div>

<script>
  window.onload = function() { window.print(); }
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

export default router;
