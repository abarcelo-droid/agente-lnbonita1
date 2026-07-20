import { Router } from "express";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { fileURLToPath as ftu } from "url";
const __d2 = path.dirname(ftu(import.meta.url));
const db = new Database(path.join(__d2, "../../data/clientes.db"));

import { documento as pdfDocumento, badgesHtml, marcaPrefix, catRow, ordenarPorCategoria, presentacionText, NOTA_BAJO_PEDIDO } from "../servicios/pricingPdfEstilo.js";
import {
  listarProductos, obtenerProducto, upsertProducto,
  actualizarPrecio, eliminarProducto,
  listarRetailProductos, crearRetailProducto, eliminarRetailProducto, actualizarRetailProducto,
  listarGastos, crearGasto, actualizarGasto, eliminarGasto,
  guardarSeleccion, vistaRetail,
  guardarPreciosCanal,
  obtenerEANs, guardarEAN,
  guardarObservacionRetail,
  listarDedicados, crearDedicado, actualizarDedicado, eliminarDedicado,
  obtenerPreciosDedicado, guardarPrecioDedicado, eliminarPrecioDedicado, crearPedidoDedicado
} from "../servicios/catalogo_v2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOTOS_DIR = path.join(__dirname, "../../data/uploads/fotos");
fs.mkdirSync(FOTOS_DIR, { recursive: true });
const upload = multer({ dest: FOTOS_DIR });

const router = Router();

// Listar productos de una oferta con precios
router.get("/oferta/:oferta", (req, res) => {
  const { oferta } = req.params;
  const soloDisponibles = req.query.disponibles === "1";
  if (!['oferta1','oferta2'].includes(oferta)) return res.status(400).json({ error: "Oferta invalida" });
  let productos = listarProductos(oferta);
  // "Bajo pedido 48hs" (3) se muestra en Pricing como Disponible(1)/Próximamente(2): tiene precio
  // editable y sí se puede pedir. Solo se filtran Sin stock (0) y MNC (-1).
  if (soloDisponibles) productos = productos.filter(p => p.disponible_general === 1 || p.disponible_general === 2 || p.disponible_general === 3);
  res.json(productos);
});

// Obtener un producto
router.get("/oferta/producto/:id", (req, res) => {
  const p = obtenerProducto(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: "No encontrado" });
  res.json(p);
});

// Crear/actualizar producto
router.post("/oferta/producto", upload.single("foto"), (req, res) => {
  const datos = { ...req.body };
  if (req.file) datos.foto_path = "/data/uploads/fotos/" + req.file.filename;
  const id = upsertProducto(datos);
  res.status(201).json({ ok: true, id });
});

// Eliminar producto
router.delete("/oferta/producto/:id", (req, res) => {
  eliminarProducto(parseInt(req.params.id));
  res.json({ ok: true });
});

// Actualizar precio/disponibilidad por tipo de cliente
router.post("/oferta/precio", (req, res) => {
  const { producto_id, tipo_cliente, precio, disponible } = req.body;
  actualizarPrecio(producto_id, tipo_cliente, precio, disponible);
  res.json({ ok: true });
});

// Archivos maestros: productos retail
router.get("/retail/productos", (req, res) => res.json(listarRetailProductos()));
router.post("/retail/productos", (req, res) => {
  const { nombre, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  crearRetailProducto(nombre.trim(), categoria||null);
  res.status(201).json({ ok: true });
});
router.delete("/retail/productos/:id", (req, res) => {
  eliminarRetailProducto(req.params.id);
  res.json({ ok: true });
});

// Editar producto retail
router.patch("/retail/productos/:id", (req, res) => {
  const { nombre, categoria, bxp_salida } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  actualizarRetailProducto(req.params.id, nombre.trim(), categoria||null, bxp_salida||null);
  res.json({ ok: true });
});

// EANs por supermercado
router.get("/retail/ean/:id", (req, res) => {
  res.json(obtenerEANs(req.params.id));
});
router.post("/retail/ean", (req, res) => {
  const { retail_producto_id, supermercado, ean } = req.body;
  guardarEAN(retail_producto_id, supermercado, ean);
  res.json({ ok: true });
});

// Archivos maestros: matriz de gastos
router.get("/retail/gastos", (req, res) => res.json(listarGastos()));
router.post("/retail/gastos", (req, res) => {
  const { nombre, proveedor, monto } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  crearGasto(nombre.trim(), proveedor||null, monto);
  res.status(201).json({ ok: true });
});
router.patch("/retail/gastos/:id", (req, res) => {
  actualizarGasto(req.params.id, req.body.nombre, req.body.proveedor, req.body.monto);
  res.json({ ok: true });
});
router.delete("/retail/gastos/:id", (req, res) => {
  eliminarGasto(req.params.id);
  res.json({ ok: true });
});

// Vista retail completa
router.get("/retail/vista", (req, res) => res.json(vistaRetail()));

// Guardar observacion de producto retail
router.post("/retail/observacion", (req, res) => {
  const { retail_producto_id, observaciones } = req.body;
  guardarObservacionRetail(retail_producto_id, observaciones);
  res.json({ ok: true });
});

// PDF de pricing por tipo de cliente
router.get("/pricing/pdf/:tipo", async (req, res) => {
  const { tipo } = req.params;

  // Caso especial: Disponible Piso (May MCBA + Min MCBA en dos columnas)
  if (tipo === 'disponible_piso') {
    // Incluir disponibles (1), próximamente (2), consignación, MNC (-1) y bajo pedido 48hs (3)
    const todosProds = db.prepare(`
      SELECT * FROM oferta_productos
      WHERE oferta = 'oferta1' AND activo = 1
        AND disponible_general IN (1, 2, -1, 3)
      ORDER BY categoria, nombre
    `).all();

    const preciosMay = db.prepare("SELECT producto_id, precio, COALESCE(disponible_text, CASE WHEN disponible=1 THEN 'disponible' ELSE 'sin_stock' END) as disponible_text FROM oferta_precios WHERE tipo_cliente = 'mayorista_mcba'").all();
    const preciosMin = db.prepare("SELECT producto_id, precio, COALESCE(disponible_text, CASE WHEN disponible=1 THEN 'disponible' ELSE 'sin_stock' END) as disponible_text FROM oferta_precios WHERE tipo_cliente = 'minorista_mcba'").all();
    const mapMay = {}; preciosMay.forEach(function(p){ mapMay[p.producto_id] = p; });
    const mapMin = {}; preciosMin.forEach(function(p){ mapMin[p.producto_id] = p; });
    const fecha = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});

    // Separar MNC del resto
    // Regla: incluir si tiene precio en May o Min, O si es consignación disponible (con o sin precio)
    const prodsNormalesRaw = todosProds.filter(function(p) {
      if (p.disponible_general === -1) return false; // MNC va aparte
      const pMay = mapMay[p.id]; const pMin = mapMin[p.id];
      const tienePrecio = (pMay && pMay.precio > 0) || (pMin && pMin.precio > 0);
      const esConsig = p.consignacion === 1;
      return tienePrecio || esConsig;
    });
    const prodsMnc = todosProds.filter(function(p) {
      return p.disponible_general === -1;
    });

    // Orden fijo de grupos (helper): Nacionales → Importadas → Hortalizas; nuevas al final.
    const prodsNormales = ordenarPorCategoria(prodsNormalesRaw);

    function fmtPrecio(pMap, id, cons) {
      const p = pMap[id];
      if (!p || !p.precio) return cons ? '(cons.)' : '-';
      return '$' + Number(p.precio).toLocaleString('es-AR');
    }

    function buildRow(p) {
      let r = '<tr>';
      r += '<td style="font-weight:700">' + p.nombre + badgesHtml(p) + '</td>';
      r += '<td>' + (presentacionText(p.kilaje) || '-') + '</td>';
      const provText = p.proveedor ? (p.marca ? p.proveedor + ' (' + p.marca + ')' : p.proveedor) : '-';
      r += '<td>' + provText + '</td>';
      r += '<td style="color:#7a6055">' + (p.origen||'-') + '</td>';
      r += '<td class="num">' + fmtPrecio(mapMay, p.id, p.consignacion) + '</td>';
      r += '<td class="num">' + fmtPrecio(mapMin, p.id, p.consignacion) + '</td>';
      r += '</tr>';
      return r;
    }

    let rows = ''; let catActual = '';
    prodsNormales.forEach(function(p) {
      if (p.categoria !== catActual) {
        catActual = p.categoria;
        rows += catRow(catActual, 6);
      }
      rows += buildRow(p);
    });

    let mncRows = '';
    prodsMnc.forEach(function(p) { mncRows += buildRow(p); });

    const mncSection = mncRows ? `
      <div style="margin-top:28px;page-break-inside:avoid">
        <div style="background:#7f1d1d;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:6px 10px;border-radius:4px 4px 0 0">
          MNC — Precio de Remate
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr style="background:#fee2e2">
            <th style="padding:5px 8px;text-align:left">Producto</th>
            <th style="padding:5px 8px;text-align:left">Presentación</th>
            <th style="padding:5px 8px;text-align:left">Proveedor</th>
            <th style="padding:5px 8px;text-align:left">Origen</th>
            <th style="padding:5px 8px;text-align:right">May MCBA</th>
            <th style="padding:5px 8px;text-align:right">Min MCBA</th>
          </tr></thead>
          <tbody>${mncRows}</tbody>
        </table>
      </div>` : '';

    // Formato institucional compartido (helper). El thead de 6 columnas y la sección MNC
    // son propios del Piso; el resto (logo, paleta, header, leyenda, badges, grupos) viene
    // del helper — misma fuente que usan los 4 PDFs por tipo de cliente.
    const html = pdfDocumento({
      titulo: 'Disponible Piso',
      fecha,
      theadHtml: '<thead><tr><th>Producto</th><th>Presentación</th><th>Proveedor</th><th>Origen</th><th class="num">May. MCBA</th><th class="num">Min. MCBA</th></tr></thead>',
      tbodyHtml: rows,
      extraHtml: mncSection,
      notaAlPie: prodsNormales.some(function(p){ return p.disponible_general === 3; }) ? NOTA_BAJO_PEDIDO : '',
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="disponible-piso.html"');
    return res.send(html);
  }
  const LABELS = {
    mayorista_a:'Mayorista A', mayorista_mcba:'Mayorista MCBA',
    minorista_mcba:'Minorista MCBA', minorista_entrega:'Minorista Entrega',
    food_service:'Food Service', consumidor_final:'Consumidor Final'
  };
  const OFERTA = ['mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega'].includes(tipo) ? 'oferta1' : 'oferta2';
  const label = LABELS[tipo] || tipo;

  const prodsRaw = db.prepare("SELECT * FROM oferta_productos WHERE oferta = ? AND activo = 1 ORDER BY categoria, nombre").all(OFERTA);
  const prods = ordenarPorCategoria(prodsRaw);   // orden fijo de grupos (Nacionales → Importadas → Hortalizas)
  const precios = db.prepare("SELECT producto_id, precio, COALESCE(disponible_text, CASE WHEN disponible=1 THEN 'disponible' ELSE 'sin_stock' END) as disponible_text FROM oferta_precios WHERE tipo_cliente = ?").all(tipo);
  const precMap = {};
  precios.forEach(function(p){ precMap[p.producto_id] = p; });

  const fecha = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});

  // PDFs a CLIENTES (Mayorista A y Minorista MCBA): en vez del badge "consignación" (modalidad
  // interna de compra) muestran la MARCA del producto. Los internos (May MCBA, Min Entrega, Piso)
  // siguen mostrando consignación y sin marca.
  const badgeOpts = ['mayorista_a', 'minorista_mcba'].includes(tipo) ? { consignacion: false, marca: true } : {};

  // Minorista MCBA (lista a clientes): además de lo disponible, incluye los productos en
  // CONSIGNACIÓN aunque no tengan precio cargado, mostrando "Consultar" (espeja al Piso, que ya
  // los lista con "(cons.)"). Aislado a este tipo; los otros 3 por-tipo no cambian.
  const esMinMcba = tipo === 'minorista_mcba';

  let rows = '';
  let catActual = '';
  let hayBajoPedido = false;
  prods.forEach(function(p) {
    const prec = precMap[p.id];
    const consigMcba = esMinMcba && p.consignacion === 1;   // consignación en Min MCBA: siempre visible
    // Mostrar si está disponible para este cliente, O si es "bajo pedido 48hs" (3) con precio
    // cargado, O (solo Min MCBA) si es consignación aunque no tenga precio. Los sin_stock comunes
    // (sin flag ni consignación) siguen ocultos.
    if (!prec && !consigMcba) return;
    const mostrar = (prec && prec.disponible_text === 'disponible')
      || (prec && p.disponible_general === 3 && Number(prec.precio) > 0)
      || consigMcba;
    if (!mostrar) return;
    if (p.categoria !== catActual) {
      catActual = p.categoria;
      rows += catRow(catActual, 5);
    }
    if (p.disponible_general === 3) hayBajoPedido = true;
    // Precio: monto si hay; en Min MCBA sin precio → "Consultar" (los otros tipos no llegan acá sin precio).
    const precioNum = prec ? Number(prec.precio || 0) : 0;
    const precioCell = precioNum > 0
      ? '<td class="num">$' + precioNum.toLocaleString('es-AR') + '</td>'
      : (esMinMcba ? '<td class="num" style="color:#7a6055;font-weight:600">Consultar</td>' : '<td class="num">$0</td>');
    // Marca protagonista ANTES del nombre (clientes); origen y presentación en columnas separadas.
    rows += '<tr><td style="font-weight:700">' + marcaPrefix(p, badgeOpts) + p.nombre + badgesHtml(p, badgeOpts) + '</td><td style="color:#7a6055">' + (p.descripcion||'') + '</td><td style="color:#7a6055">' + (p.origen||'-') + '</td><td style="color:#7a6055;white-space:nowrap">' + (presentacionText(p.kilaje) || '-') + '</td>' + precioCell + '</tr>';
  });

  // Mismo formato institucional que el Piso (helper): logo LNB + header + paleta + leyenda
  // de badges. Título parametrizado por tipo de cliente; una sola columna de precio (la del tipo).
  const html = pdfDocumento({
    titulo: 'Lista de precios - ' + label,
    fecha,
    theadHtml: '<thead><tr><th style="width:34%">Producto</th><th style="width:24%">Variedad</th><th style="width:16%">Origen</th><th style="width:14%">Presentación</th><th class="num" style="width:12%">Precio</th></tr></thead>',
    tbodyHtml: rows,
    notaAlPie: hayBajoPedido ? NOTA_BAJO_PEDIDO : '',
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="precios-' + tipo + '.html"');
  res.send(html);
});

// Guardar precios por canal
router.post("/retail/precios-canal", (req, res) => {
  const { retail_producto_id, precios } = req.body;
  guardarPreciosCanal(retail_producto_id, precios);
  res.json({ ok: true });
});

// Guardar seleccion proveedor + gastos
router.post("/retail/seleccion", (req, res) => {
  const { retail_producto_id, oferta_producto_id, gastos_ids } = req.body;
  guardarSeleccion(retail_producto_id, oferta_producto_id, gastos_ids);
  res.json({ ok: true });
});

// Actualizar disponibilidad general del producto
router.post("/oferta/producto/disponibilidad", (req, res) => {
  const { producto_id, disponible } = req.body;
  db.prepare("UPDATE oferta_productos SET disponible_general = ? WHERE id = ?").run(parseInt(disponible), parseInt(producto_id));
  res.json({ ok: true });
});

// Actualizar nombre_retail de un producto de oferta
router.post("/oferta/producto/nombre-retail", (req, res) => {
  const { producto_id, nombre_retail } = req.body;
  db.prepare("UPDATE oferta_productos SET nombre_retail = ? WHERE id = ?").run(nombre_retail || null, parseInt(producto_id));
  res.json({ ok: true });
});

// Actualizar campo retail de un producto
router.post("/oferta/producto/retail", (req, res) => {
  const { producto_id, retail } = req.body;
  db.prepare("UPDATE oferta_productos SET retail = ? WHERE id = ?").run(parseInt(retail) || 0, parseInt(producto_id));
  res.json({ ok: true });
});

// Limpiar duplicados — mantiene el de menor id por cada nombre+proveedor+oferta
router.post("/oferta/limpiar-duplicados", (req, res) => {
  const dups = db.prepare(`
    SELECT MIN(id) as keep_id, nombre, proveedor, oferta, COUNT(*) as cnt
    FROM oferta_productos
    WHERE activo = 1
    GROUP BY nombre, proveedor, oferta
    HAVING cnt > 1
  `).all();
  let borrados = 0;
  dups.forEach(function(d) {
    const result = db.prepare(
      "UPDATE oferta_productos SET activo = 0 WHERE nombre = ? AND (proveedor = ? OR (proveedor IS NULL AND ? IS NULL)) AND oferta = ? AND id != ?"
    ).run(d.nombre, d.proveedor, d.proveedor, d.oferta, d.keep_id);
    borrados += result.changes;
  });
  res.json({ ok: true, borrados });
});

// ── Dedicados ────────────────────────────────────────────────────────────────
router.get("/dedicados", (req, res) => res.json(listarDedicados()));

router.post("/dedicados", (req, res) => {
  try {
    const id = crearDedicado(req.body);
    res.status(201).json({ ok: true, id });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch("/dedicados/:id", (req, res) => {
  actualizarDedicado(req.params.id, req.body);
  res.json({ ok: true });
});

router.delete("/dedicados/:id", (req, res) => {
  eliminarDedicado(req.params.id);
  res.json({ ok: true });
});

// Precios custom por cliente dedicado
router.get("/dedicados/:id/precios", (req, res) => {
  res.json(obtenerPreciosDedicado(req.params.id));
});

router.post("/dedicados/:id/precios", (req, res) => {
  const { producto_id, precio } = req.body;
  guardarPrecioDedicado(req.params.id, producto_id, precio);
  res.json({ ok: true });
});

router.delete("/dedicados/:id/precios/:productoId", (req, res) => {
  eliminarPrecioDedicado(req.params.id, req.params.productoId);
  res.json({ ok: true });
});

// Pedidos de clientes dedicados
router.post("/dedicados/:id/pedido", (req, res) => {
  try {
    const { detalle, total } = req.body;
    if (!detalle) return res.status(400).json({ error: "Falta detalle" });
    const pedidoId = crearPedidoDedicado(req.params.id, detalle, total);
    res.status(201).json({ ok: true, id: pedidoId });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
