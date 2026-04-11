import "dotenv/config";
import express from "express";
import path    from "path";
import { fileURLToPath } from "url";
import { routearMensaje } from "./agentes/router.js";
import panelRouter  from "./rutas/panel.js";
import nuevosRouter    from "./rutas/nuevos.js";
import cobranzaRouter from "./rutas/cobranza.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Servir archivos subidos (fotos, facturas)
app.use("/data/uploads", express.static(path.join(__dirname, "../data/uploads")));

// Archivos estaticos del panel (logo, etc)
app.use("/static", express.static(path.join(__dirname, ".")));

// Panel web
app.get("/panel", (req, res) => res.sendFile(path.join(__dirname, "panel.html")));

// Webhook WhatsApp
app.post("/webhook", async (req, res) => {
  const telefono = req.body.From?.replace("whatsapp:", "") || req.body.telefono;
  const mensaje  = req.body.Body || req.body.mensaje;
  if (!telefono || !mensaje) return res.status(400).json({ error: "Faltan campos" });

  console.log(`[${new Date().toLocaleTimeString()}] ${telefono}: ${mensaje}`);
  try {
    const respuesta = await routearMensaje(telefono, mensaje);
    // null = conversación pausada, no responder
    if (!respuesta) return res.set("Content-Type","text/xml").send("<Response></Response>");
    res.set("Content-Type","text/xml");
    res.send(`<Response><Message><Body>${respuesta}</Body></Message></Response>`);
  } catch (error) {
    console.error("Error en webhook:", error);
    res.set("Content-Type","text/xml");
    res.send(`<Response><Message><Body>Disculpá, hubo un problema. Intentá de nuevo en un momento.</Body></Message></Response>`);
  }
});

// APIs
app.use("/api", panelRouter);
app.use("/api", nuevosRouter);
app.use("/api", cobranzaRouter);

// Health check
app.get("/", (req, res) => res.json({ status:"ok", version:"3.0", panel:"/panel" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor en http://localhost:${PORT}`);
  console.log(`   Panel:   http://localhost:${PORT}/panel`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook\n`);
});
