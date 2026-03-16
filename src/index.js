import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { routearMensaje } from "./agentes/router.js";
import panelRouter from "./rutas/panel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Panel web visual
app.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "panel.html"));
});

// Webhook de WhatsApp (Twilio)
app.post("/webhook", async (req, res) => {
  const telefono = req.body.From?.replace("whatsapp:", "") || req.body.telefono;
  const mensaje  = req.body.Body || req.body.mensaje;

  if (!telefono || !mensaje) {
    return res.status(400).json({ error: "Faltan campos: From/telefono y Body/mensaje" });
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${telefono}: ${mensaje}`);

  try {
    const respuesta = await routearMensaje(telefono, mensaje);
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message><Body>${respuesta}</Body></Message></Response>`);
  } catch (error) {
    console.error("Error en webhook:", error);
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message><Body>Hubo un problema técnico. Por favor intentá de nuevo.</Body></Message></Response>`);
  }
});

// API REST del panel
app.use("/api", panelRouter);

// Health check
app.get("/", (req, res) => res.json({ status: "ok", version: "2.0", panel: "/panel" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Panel:    http://localhost:${PORT}/panel`);
  console.log(`   Webhook:  POST http://localhost:${PORT}/webhook`);
  console.log(`   API:      http://localhost:${PORT}/api/clientes\n`);
});
