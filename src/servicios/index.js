import "dotenv/config";
import express from "express";
import path    from "path";
import { fileURLToPath } from "url";
import { routearMensaje } from "./agentes/router.js";
import panelRouter    from "./rutas/panel.js";
import nuevosRouter   from "./rutas/nuevos.js";
import cobranzaRouter from "./rutas/cobranza.js";
import ofertaRouter       from "./rutas/oferta.js";
import cotizacionRouter   from "./rutas/cotizacion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Archivos estaticos
app.use("/static",       express.static(path.join(__dirname, ".")));
app.use("/data/uploads", express.static(path.join(__dirname, "../data/uploads")));

// Panel web
app.get("/panel", (req, res) => res.sendFile(path.join(__dirname, "panel.html")));

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

    // null = conversacion pausada
    if (!respuesta) {
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }

    // Responder via TwiML (Twilio Markup Language)
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

// Health check
app.get("/", (req, res) => res.json({ status:"ok", version:"3.0", panel:"/panel" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n Servidor en http://localhost:${PORT}`);
  console.log(`   Panel:   http://localhost:${PORT}/panel`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook\n`);
});
