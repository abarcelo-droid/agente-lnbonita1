import "dotenv/config";
import express from "express";
import path    from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import { routearMensaje } from "./agentes/router.js";
import panelRouter        from "./rutas/panel.js";
import nuevosRouter       from "./rutas/nuevos.js";
import cobranzaRouter     from "./rutas/cobranza.js";
import ofertaRouter       from "./rutas/oferta.js";
import cotizacionRouter   from "./rutas/cotizacion.js";
import crmRouter          from "./rutas/crm.js";
import buscarRouter       from "./rutas/buscar.js";
import abastoRouter       from "./rutas/abasto.js";
import authRouter         from "./rutas/auth.js";
import produccionRouter   from "./rutas/produccion.js";
import scoutRouter        from "./rutas/scout.js";
import { guardarSnapshotCRM } from "./servicios/db.js";
import { syncSheets } from "./servicios/sheets.js";

// Scheduler: snapshot CRM + sync sheets a medianoche
function programarSnapshotCRM() {
  const ahora = new Date();
  const medianoche = new Date(ahora);
  medianoche.setHours(24, 0, 0, 0);
  const msHastaMedianoche = medianoche - ahora;
  console.log(`[CRM] Snapshot programado en ${Math.round(msHastaMedianoche/1000/60)} minutos`);
  setTimeout(function() {
    guardarSnapshotCRM();
    syncSheets();
    setInterval(function() {
      guardarSnapshotCRM();
      syncSheets();
    }, 24 * 60 * 60 * 1000);
  }, msHastaMedianoche);
}

// Sync inicial al arrancar si no hay datos
import db from "./servicios/db.js";
setTimeout(function() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM sheet_compras").get();
    if (!n || n.n === 0) {
      console.log('[Sheets] Sin datos locales, iniciando sync inicial...');
      syncSheets().catch(e => console.error('[Sheets] Error sync inicial:', e.message));
    }
  } catch(e) {}
}, 8000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));
app.use(cookieParser());

// Archivos estaticos
app.use("/static",       express.static(path.join(__dirname, ".")));
app.use("/data/uploads", express.static(path.join(__dirname, "../data/uploads")));
app.use("/data/conformados", express.static(path.join(__dirname, "../data/conformados")));
app.use("/data/fichas",      express.static(path.join(__dirname, "../data/fichas")));
app.use("/data/remitos_pa", express.static(path.join(__dirname, "../data/remitos_pa")));

// Auth
app.use("/api/auth", authRouter);

// Panel web — protegido: si no hay cookie redirige a login
app.get("/panel", (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.redirect('/login');
  try {
    const user = JSON.parse(cookie);
    // Usuarios de campo solo pueden ir al Scout
    if (user.rol === 'campo') return res.redirect('/scout');
  } catch(e) {}
  res.sendFile(path.join(__dirname, "panel.html"));
});

// Login page
app.get("/login", (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (cookie) {
    try {
      const user = JSON.parse(cookie);
      return res.redirect(user.rol === 'campo' ? '/scout' : '/panel');
    } catch(e) {}
  }
  res.sendFile(path.join(__dirname, "login.html"));
});

// Webhook WhatsApp (Twilio)
app.post("/webhook", async (req, res) => {
  const telefono = req.body.From?.replace("whatsapp:", "") || req.body.telefono;
  const mensaje  = req.body.Body || req.body.mensaje;

  if (!telefono || !mensaje) {
    return res.set("Content-Type","text/xml").send("<Response></Response>");
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${telefono}: ${mensaje}`);

  try {
    const respuesta = await routearMensaje(telefono, mensaje);

    if (!respuesta) {
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>
    <Body>${respuesta.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</Body>
  </Message>
</Response>`;

    res.set("Content-Type","text/xml").send(twiml);

  } catch (error) {
    console.error("Error en webhook:", error);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>
    <Body>Disculpa, hubo un problema tecnico. Intenta de nuevo en un momento.</Body>
  </Message>
</Response>`;
    res.set("Content-Type","text/xml").send(twiml);
  }
});

// APIs
app.use("/api", panelRouter);
app.use("/api", nuevosRouter);
app.use("/api", cobranzaRouter);
app.use("/api", ofertaRouter);
app.use("/api", cotizacionRouter);
app.use("/api", crmRouter);
app.use("/api", buscarRouter);
app.use("/api/abasto", abastoRouter);
app.use("/api/pa",     produccionRouter);
app.use("/api/pa/scout", scoutRouter);

// Scout — app mobile para campo
app.get("/scout", (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.redirect('/login?next=/scout');
  res.sendFile(path.join(__dirname, "scout.html"));
});

// Archivos scout (fotos)
app.use("/data/scout", express.static(path.join(__dirname, "../data/scout")));

// Health check
app.get("/", (req, res) => res.json({ status:"ok", version:"3.0", panel:"/panel" }));

// ⚠️ TEMPORAL — BACKUP DE LA DB — BORRAR DESPUÉS DE DESCARGAR
// Descarga: /backup-db-lnb-2026
app.get("/backup-db-lnb-2026", async (req, res) => {
  const dbPath = path.join(__dirname, "../data/clientes.db");
  const backupPath = path.join(__dirname, "../data/clientes-backup-tmp.db");
  try {
    const fsMod = await import("fs");
    if (!fsMod.existsSync(dbPath)) {
      return res.status(404).send("DB no encontrada en " + dbPath);
    }
    // Usar backup API de SQLite (crea copia consistente aun con la DB en uso)
    console.log("[BACKUP] Creando copia consistente...");
    await db.backup(backupPath);
    const stats = fsMod.statSync(backupPath);
    console.log(`[BACKUP] Enviando ${(stats.size/1024/1024).toFixed(2)} MB`);
    res.setHeader("Content-Type", "application/x-sqlite3");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Disposition",
      `attachment; filename="lnb-backup-${new Date().toISOString().slice(0,10)}.db"`);
    const stream = fsMod.createReadStream(backupPath);
    stream.on("end", () => {
      // Eliminar copia temporal después de enviarla
      fsMod.unlink(backupPath, () => {});
    });
    stream.on("error", (e) => {
      console.error("[BACKUP] Stream error:", e);
      if (!res.headersSent) res.status(500).send("Stream error: " + e.message);
    });
    stream.pipe(res);
  } catch(e) {
    console.error("[BACKUP] Error:", e);
    if (!res.headersSent) res.status(500).send("Error: " + e.message);
  }
});

// ⚠️ TEMPORAL — LISTAR ARCHIVOS EN /app/data — para diagnóstico
app.get("/backup-ls-lnb-2026", async (req, res) => {
  try {
    const fsMod = await import("fs");
    const dataDir = path.join(__dirname, "../data");
    const items = fsMod.readdirSync(dataDir, { withFileTypes: true }).map(function(d){
      const full = path.join(dataDir, d.name);
      let size = null;
      try { size = d.isFile() ? fsMod.statSync(full).size : null; } catch(e) {}
      return { name: d.name, isDirectory: d.isDirectory(), size: size };
    });
    res.json({ dataDir, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n Servidor en http://localhost:${PORT}`);
  console.log(`   Panel:   http://localhost:${PORT}/panel`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook\n`);
  programarSnapshotCRM();
});
