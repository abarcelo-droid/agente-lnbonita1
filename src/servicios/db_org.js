// src/servicios/db_org.js
// ─── Schema organizacional ─────────────────────────────────────────────
// Tablas: sociedades, areas, ubicaciones, personas, personas_areas.
// Vínculos opcionales: usuarios.persona_id, proveedores.sociedad_id.
// Fase 1: solo modelado. No toca el flujo de login ni los permisos actuales.

import { getDb } from './db.js';

const db = getDb();

// ─── TABLAS NUEVAS ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sociedades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT NOT NULL UNIQUE,
    cuit         TEXT,
    tipo         TEXT NOT NULL DEFAULT 'interna' CHECK(tipo IN ('interna','externa')),
    funcion      TEXT,
    activa       INTEGER DEFAULT 1,
    creada_en    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS areas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id  INTEGER NOT NULL REFERENCES sociedades(id),
    nombre       TEXT NOT NULL,
    descripcion  TEXT,
    activa       INTEGER DEFAULT 1,
    creada_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_areas_sociedad ON areas(sociedad_id);

  CREATE TABLE IF NOT EXISTS ubicaciones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT NOT NULL,
    direccion    TEXT,
    lat          REAL,
    lng          REAL,
    notas        TEXT,
    creada_en    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS personas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dni          TEXT,
    nombre       TEXT NOT NULL,
    apellido     TEXT,
    mail         TEXT,
    telefono     TEXT,
    foto_url     TEXT,
    ubicacion_id INTEGER REFERENCES ubicaciones(id),
    notas        TEXT,
    activo       INTEGER DEFAULT 1,
    creada_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_personas_dni      ON personas(dni);
  CREATE INDEX IF NOT EXISTS idx_personas_apellido ON personas(apellido);
  CREATE INDEX IF NOT EXISTS idx_personas_activo   ON personas(activo);

  CREATE TABLE IF NOT EXISTS personas_areas (
    persona_id   INTEGER NOT NULL REFERENCES personas(id),
    area_id      INTEGER NOT NULL REFERENCES areas(id),
    rol_en_area  TEXT,
    desde        TEXT DEFAULT (date('now','localtime')),
    hasta        TEXT,
    PRIMARY KEY (persona_id, area_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pa_area ON personas_areas(area_id);
`);

// ─── ALTERs opcionales en tablas existentes ────────────────────────────
// Vinculan registros viejos al nuevo modelo sin romper nada.
try { db.exec("ALTER TABLE usuarios ADD COLUMN persona_id INTEGER REFERENCES personas(id)"); } catch(_) {}
try { db.exec("ALTER TABLE proveedores ADD COLUMN sociedad_id INTEGER REFERENCES sociedades(id)"); } catch(_) {}

// Fase 1.b: jerarquía — cada persona puede reportar a otra
try { db.exec("ALTER TABLE personas ADD COLUMN reporta_a_id INTEGER REFERENCES personas(id)"); } catch(_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_personas_reporta_a ON personas(reporta_a_id)"); } catch(_) {}

// Fase 1.b: cargo de la persona (texto libre, ej. "Gerente Comercial", "CEO")
try { db.exec("ALTER TABLE personas ADD COLUMN cargo TEXT"); } catch(_) {}

// Fase 1.c: reportar al Directorio como entidad (sin un manager persona específico)
// Mutuamente excluyente con reporta_a_id: o reportás a una persona, o al Directorio
try { db.exec("ALTER TABLE personas ADD COLUMN reporta_a_directorio INTEGER DEFAULT 0"); } catch(_) {}

// Fase 1.b: rename Estructura → Familia + soft delete del área Family Office
// (idempotente: solo afecta si todavía se llaman así)
try {
  db.prepare("UPDATE sociedades SET nombre = 'Familia' WHERE nombre = 'Estructura'").run();
  db.prepare(`
    UPDATE areas SET activa = 0
    WHERE nombre = 'Family Office'
      AND sociedad_id IN (SELECT id FROM sociedades WHERE nombre = 'Familia')
      AND activa = 1
  `).run();
} catch(e) { console.error("[ORG] Error migrando Familia:", e.message); }

// Fase 1.b: asegurar que existe el área "Directorio" en Familia (idempotente)
try {
  const familia = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Familia' AND activa = 1").get();
  if (familia) {
    const tiene = db.prepare("SELECT 1 FROM areas WHERE sociedad_id = ? AND nombre = 'Directorio' AND activa = 1").get(familia.id);
    if (!tiene) {
      db.prepare("INSERT INTO areas (sociedad_id, nombre) VALUES (?, 'Directorio')").run(familia.id);
      console.log("[ORG] Área 'Directorio' creada en Familia");
    }
  }
} catch(e) { console.error("[ORG] Error creando Directorio:", e.message); }

// ─── SEED: 4 sociedades internas + áreas confirmadas ───────────────────
(function seedOrg() {
  try {
    const n = db.prepare("SELECT COUNT(*) AS n FROM sociedades").get().n;
    if (n > 0) return;

    const insertSoc  = db.prepare("INSERT INTO sociedades (nombre, tipo, funcion) VALUES (?,?,?)");
    const insertArea = db.prepare("INSERT INTO areas (sociedad_id, nombre) VALUES (?,?)");

    const sociedades = [
      { nombre: 'Puente Cordón SA',       funcion: 'productiva', areas: ['Producción','Cosecha','Personal agrícola'] },
      { nombre: 'San Gerónimo SA',        funcion: 'comercial',  areas: ['Comercial','Logística','Operativo IFCO','Administración'] },
      { nombre: 'Barceló Transporte SRL', funcion: 'transporte', areas: [] },
      { nombre: 'Familia',                funcion: 'estructura', areas: ['Directorio','Contadores','Abogados'] },
    ];

    db.transaction(() => {
      for (const s of sociedades) {
        const r = insertSoc.run(s.nombre, 'interna', s.funcion);
        for (const a of s.areas) insertArea.run(r.lastInsertRowid, a);
      }
    })();

    console.log(`[ORG] Seed: ${sociedades.length} sociedades + áreas creadas`);
  } catch(e) {
    console.error("[ORG] Error seed:", e.message);
  }
})();

// ─── FASE 3.A: nivel de acceso de personas (0-4) ────────────────────────
// 0: Nivel Directivo            — acceso total y modificaciones
// 1: Nivel Gerencial            — acceso a todos los números de su sociedad
// 2: Nivel Ejecutivo            — solo operativos: panel y apps
// 3: Nivel Administrativo/Operativo — operativos solo apps
// 4: Externo                    — operativos externos a la empresa
try { db.exec("ALTER TABLE personas ADD COLUMN nivel_acceso INTEGER DEFAULT 0"); } catch(_) {}

// ─── FASE 3.A: configuración de módulos del panel ────────────────────────
// Cada módulo del sidebar pertenece a una sociedad y tiene un tipo.
// Esto define quién lo ve según (sociedad_visible × nivel_acceso).
// El admin puede modificar la asignación desde la UI.
db.exec(`
  CREATE TABLE IF NOT EXISTS modulos_config (
    modulo       TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    grupo        TEXT NOT NULL,
    sociedad_id  INTEGER REFERENCES sociedades(id),
    tipo         TEXT NOT NULL DEFAULT 'operativo' CHECK(tipo IN ('numero','operativo','mobile','externo','sistema')),
    orden        INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_modulos_grupo    ON modulos_config(grupo);
  CREATE INDEX IF NOT EXISTS idx_modulos_sociedad ON modulos_config(sociedad_id);
`);

// FASE 3.A v2 — agregar área específica del módulo + flag de oculto (idempotente)
try { db.exec("ALTER TABLE modulos_config ADD COLUMN area_id INTEGER REFERENCES areas(id)"); } catch(_) {}
try { db.exec("ALTER TABLE modulos_config ADD COLUMN oculto INTEGER NOT NULL DEFAULT 0"); } catch(_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_modulos_area ON modulos_config(area_id)"); } catch(_) {}

// Seed inicial de los 65 módulos detectados del sidebar.
// Defaults razonables; el admin puede ajustarlos desde la UI.
(function seedModulos() {
  try {
    const n = db.prepare("SELECT COUNT(*) AS n FROM modulos_config").get().n;
    if (n > 0) return;  // idempotente

    // Helper: obtener ID de sociedad por nombre (puede ser null si no existe)
    const sid = (nombre) => {
      const r = db.prepare("SELECT id FROM sociedades WHERE nombre = ?").get(nombre);
      return r ? r.id : null;
    };
    const SG = sid('San Gerónimo SA');
    const PC = sid('Puente Cordón SA');
    const FAM = sid('Familia');
    // BT = sid('Barceló Transporte SRL'); // no usado por default, admin lo asigna

    const insert = db.prepare(
      "INSERT INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
    );

    const modulos = [
      // ── General / Sistema (transversal, todos ven)
      ['inicio',              'Inicio / Dashboard',         'General',       null, 'sistema',   10],
      ['calendario',          'Calendario',                 'General',       null, 'sistema',   11],
      ['conv',                'Conversaciones',             'General',       null, 'sistema',   12],
      ['equipo',              'Equipo (Organigrama)',       'Sistema',       null, 'sistema',  900],
      ['maestro-usuarios',    'Usuarios',                   'Sistema',       null, 'sistema',  901],
      ['ingreso-factura',     'Ingreso de Factura',         'General',       null, 'operativo', 13],

      // ── Comercial / CRM (San Gerónimo)
      ['crm',                 'CRM Dedicados',              'Comercial',     SG,   'operativo', 100],
      ['dedicados',           'Dedicados',                  'Comercial',     SG,   'operativo', 101],
      ['food',                'Food Service',               'Comercial',     SG,   'operativo', 102],
      ['may-a',               'Mayorista A',                'Comercial',     SG,   'operativo', 103],
      ['may-mcba',            'Mayorista MCBA',             'Comercial',     SG,   'operativo', 104],
      ['min-mcba',            'Minorista MCBA',             'Comercial',     SG,   'operativo', 105],
      ['min-ent',             'Minorista Entrega',          'Comercial',     SG,   'operativo', 106],
      ['cons-final',          'Consumidor Final',           'Comercial',     SG,   'operativo', 107],
      ['pedidos',             'Pedidos',                    'Comercial',     SG,   'operativo', 108],
      ['repet',               'Recompra',                   'Comercial',     SG,   'operativo', 109],

      // ── Pricing & Ofertas (números, San Gerónimo)
      ['pricing1',            'Pricing 1',                  'Pricing',       SG,   'numero',    200],
      ['pricing2',            'Pricing 2',                  'Pricing',       SG,   'numero',    201],
      ['oferta1',             'Oferta 1',                   'Pricing',       SG,   'numero',    202],
      ['oferta2',             'Oferta 2',                   'Pricing',       SG,   'numero',    203],

      // ── Logística (San Gerónimo)
      ['logistica',           'Logística',                  'Logística',     SG,   'operativo', 300],
      ['envios',              'Envíos',                     'Logística',     SG,   'operativo', 301],
      ['preparacion',         'Preparación',                'Logística',     SG,   'operativo', 302],
      ['remitos',             'Remitos',                    'Logística',     SG,   'operativo', 303],
      ['guardias',            'Guardias',                   'Logística',     SG,   'operativo', 304],

      // ── Cobranzas (números, San Gerónimo)
      ['cobranza',            'Cobranza',                   'Cobranzas',     SG,   'numero',    400],
      ['cta-cte',             'Cuenta Corriente',           'Cobranzas',     SG,   'numero',    401],

      // ── Producción Agrícola (Puente Cordón)
      ['pa-dashboard',        'Dashboard PA',               'Producción',    PC,   'operativo', 500],
      ['pa-lotes',            'Lotes',                      'Producción',    PC,   'operativo', 501],
      ['pa-insumos',          'Insumos',                    'Producción',    PC,   'operativo', 502],
      ['pa-clima',            'Clima',                      'Producción',    PC,   'operativo', 503],
      ['pa-combustible',      'Combustible',                'Producción',    PC,   'operativo', 504],
      ['pa-compras',          'Compras',                    'Producción',    PC,   'operativo', 505],
      ['pa-costos',           'Costos',                     'Producción',    PC,   'numero',    506],
      ['pa-cuentas',          'Cuentas',                    'Producción',    PC,   'numero',    507],
      ['pa-calendario',       'Calendario PA',              'Producción',    PC,   'operativo', 508],
      ['pa-despachos',        'Despachos',                  'Producción',    PC,   'operativo', 509],
      ['pa-electricidad',     'Electricidad',               'Producción',    PC,   'operativo', 510],
      ['pa-ordenes',          'Órdenes',                    'Producción',    PC,   'operativo', 511],
      ['pa-panol',            'Pañol',                      'Producción',    PC,   'operativo', 512],
      ['pa-personal',         'Personal',                   'Producción',    PC,   'operativo', 513],
      ['pa-scout',            'Scout (Mobile)',             'Producción',    PC,   'mobile',    514],

      // ── Abasto IFCO (San Gerónimo)
      ['ab-dashboard',        'Dashboard IFCO',             'Abasto IFCO',   SG,   'operativo', 600],
      ['ab-gastos',           'Gastos IFCO',                'Abasto IFCO',   SG,   'numero',    601],
      ['ab-ifcos',            'IFCOs',                      'Abasto IFCO',   SG,   'operativo', 602],
      ['ab-liquidaciones',    'Liquidaciones IFCO',         'Abasto IFCO',   SG,   'numero',    603],
      ['ab-mandata',          'Mandata',                    'Abasto IFCO',   SG,   'numero',    604],
      ['ab-partidas',         'Partidas',                   'Abasto IFCO',   SG,   'operativo', 605],
      ['ab-proveedores',      'Proveedores IFCO',           'Abasto IFCO',   SG,   'operativo', 606],
      ['ab-remitos',          'Remitos IFCO',               'Abasto IFCO',   SG,   'operativo', 607],
      ['ab-stock',            'Stock IFCO',                 'Abasto IFCO',   SG,   'operativo', 608],

      // ── Administración Contable (Familia, transversal números)
      ['adm-asientos',        'Asientos',                   'Contabilidad',  FAM,  'numero',    700],
      ['adm-cc-proveedores',  'CC Proveedores',             'Contabilidad',  FAM,  'numero',    701],
      ['adm-modelos',         'Modelos',                    'Contabilidad',  FAM,  'numero',    702],
      ['adm-plan-cuentas',    'Plan de Cuentas',            'Contabilidad',  FAM,  'numero',    703],
      ['adm-proveedores',     'Proveedores',                'Contabilidad',  FAM,  'numero',    704],

      // ── Financiero (Familia)
      ['fin-caja-bancos',     'Caja / Bancos',              'Financiero',    FAM,  'numero',    750],
      ['fin-ordenes-pago',    'Órdenes de Pago',            'Financiero',    FAM,  'numero',    751],

      // ── Ventas (San Gerónimo, mayoría números)
      ['ven-clientes',        'Clientes Ventas',            'Ventas',        SG,   'operativo', 800],
      ['ven-facturas',        'Facturas Ventas',            'Ventas',        SG,   'numero',    801],
      ['ven-cobranzas',       'Cobranzas Ventas',           'Ventas',        SG,   'numero',    802],
      ['ven-cc',              'CC Ventas',                  'Ventas',        SG,   'numero',    803],
      ['ven-liquidaciones',   'Liquidaciones Ventas',       'Ventas',        SG,   'numero',    804],

      // ── Retail (San Gerónimo)
      ['retail-view',         'Retail View',                'Retail',        SG,   'operativo', 850],
      ['retail-prod',         'Retail Producción',          'Retail',        SG,   'operativo', 851],
      ['retail-gastos',       'Retail Gastos',              'Retail',        SG,   'numero',    852],
      ['rent-retail',         'Rentabilidad Retail',        'Retail',        SG,   'numero',    853],
    ];

    db.transaction(() => {
      for (const m of modulos) insert.run(...m);
    })();

    console.log(`[ORG] Seed: ${modulos.length} módulos de configuración cargados (Fase 3.A)`);
  } catch(e) {
    console.error("[ORG] Error seed modulos:", e.message);
  }
})();

console.log("[ORG] Schema organizacional inicializado");
