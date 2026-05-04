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
import cuentasRouter      from "./rutas/cuentas.js";
import climaRouter        from "./rutas/clima.js";
import ifcoRouter         from "./rutas/ifco.js";
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
app.use("/data/ifco",       express.static(path.join(__dirname, "../data/ifco")));

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
app.use("/api/ifco",   ifcoRouter);
app.use("/api/pa/cuentas", cuentasRouter);
app.use("/api/pa/clima",   climaRouter);
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

// ═════════════════════════════════════════════════════════════════════════
// PWA — Progressive Web App para Scout (instalable en celular)
// ═════════════════════════════════════════════════════════════════════════
app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, "sw.js"));
});
app.get("/icon-192.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-192.png"));
});
app.get("/icon-512.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-512.png"));
});
app.get("/icon-apple.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-apple.png"));
});
app.get("/icon-apple-152.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-apple-152.png"));
});
app.get("/icon-apple-167.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-apple-167.png"));
});
app.get("/icon-apple-120.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-apple-120.png"));
});
app.get("/icon-32.png", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-32.png"));
});
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "icon-32.png"));
});

// Health check
app.get("/", (req, res) => res.json({ status:"ok", version:"3.0", panel:"/panel" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n Servidor en http://localhost:${PORT}`);
  console.log(`   Panel:   http://localhost:${PORT}/panel`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook\n`);
  programarSnapshotCRM();
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
// Railway manda SIGTERM al redeployar. Si el proceso muere sin cerrar la DB
// se corrompe el WAL y se pierden transacciones recientes. Este handler:
//   1. Deja de aceptar conexiones nuevas.
//   2. Hace checkpoint del WAL (vuelca todo al .db principal).
//   3. Cierra la DB limpio.
//   4. Sale del proceso.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Cerrando servidor...`);

  // Timeout de seguridad: si algo se cuelga, forzar salida a los 10s
  const forceExit = setTimeout(() => {
    console.error('[SHUTDOWN] Timeout — forzando salida');
    process.exit(1);
  }, 10000);

  server.close(() => {
    console.log('[SHUTDOWN] Conexiones HTTP cerradas');
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      console.log('[SHUTDOWN] WAL checkpoint OK');
    } catch(e) { console.error('[SHUTDOWN] Error en checkpoint:', e.message); }
    try {
      db.close();
      console.log('[SHUTDOWN] DB cerrada OK');
    } catch(e) { console.error('[SHUTDOWN] Error cerrando DB:', e.message); }
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
