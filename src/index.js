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

// Auth
app.use("/api/auth", authRouter);

// Panel web — protegido: si no hay cookie redirige a login
app.get("/panel", (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.redirect('/login');
  res.sendFile(path.join(__dirname, "panel.html"));
});

// Login page
app.get("/login", (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (cookie) return res.redirect('/panel');
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n Servidor en http://localhost:${PORT}`);
  console.log(`   Panel:   http://localhost:${PORT}/panel`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook\n`);
  programarSnapshotCRM();
});
