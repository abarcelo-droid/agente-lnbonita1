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

console.log("[ORG] Schema organizacional inicializado");
