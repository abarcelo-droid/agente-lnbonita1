# Agente Multi-Cliente WhatsApp 🤖

Sistema de atención por WhatsApp para tres tipos de clientes con catálogos dinámicos desde Google Sheets.

## Estructura del proyecto

```
src/
├── index.js                   ← Servidor Express (webhook + API panel)
├── agentes/
│   ├── router.js              ← Identifica el tipo de cliente y deriva
│   ├── base.js                ← Función compartida para llamar a Claude
│   ├── mayorista.js           ← Agente mayorista (cuenta corriente)
│   ├── minorista.js           ← Agente minorista (alta + cobro online)
│   └── foodService.js         ← Agente food service (horarios de entrega)
├── servicios/
│   ├── db.js                  ← SQLite: clientes, sesiones, pedidos
│   └── sheets.js              ← Lee catálogos de Google Sheets (con cache)
└── rutas/
    └── panel.js               ← API REST del panel de control
data/
└── clientes.db                ← Base de datos SQLite (se crea sola)
```

## Setup paso a paso

### 1. Instalá dependencias
```bash
npm install
```

### 2. Configurá el entorno
```bash
cp .env.example .env
# Editá .env con tus claves
```

### 3. Configurá Google Sheets

#### a) Crear el Spreadsheet
Creá un Google Sheet con **3 hojas** con estos nombres exactos:
- `Mayorista`
- `Minorista`  
- `FoodService`

#### b) Formato de cada hoja (fila 1 = encabezado)
| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| Código | Nombre | Descripción | Precio | Unidad | Stock | Notas |
| A001 | Harina 000 | 25kg | 8500 | bolsa | si | |
| A002 | Azúcar | 50kg | 12000 | bolsa | no | sin stock esta semana |

#### c) Crear Service Account de Google
1. Ir a [console.cloud.google.com](https://console.cloud.google.com)
2. Crear proyecto → Habilitar "Google Sheets API"
3. IAM → Service Accounts → Crear cuenta → Descargar JSON
4. Copiar el JSON completo (en una sola línea) como valor de `GOOGLE_SERVICE_ACCOUNT_JSON`
5. Compartir el Spreadsheet con el email de la service account (sólo lectura)

### 4. Iniciá el servidor
```bash
npm run dev
```

---

## Probar sin WhatsApp

### Simular un mayorista conocido
```bash
# Primero registrar el cliente (desde el panel):
curl -X POST http://localhost:3000/api/clientes \
  -H "Content-Type: application/json" \
  -d '{"telefono":"+5491112345678","tipo":"mayorista","nombre":"Distribuidora López","empresa":"López SA"}'

# Luego simular un mensaje:
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"telefono":"+5491112345678","mensaje":"Hola, qué tienen hoy?"}'
```

### Simular un cliente minorista nuevo
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"telefono":"+5499887766554","mensaje":"Hola, quiero comprar"}'
# → El agente arranca el flujo de registro automáticamente
```

### Simular food service
```bash
curl -X POST http://localhost:3000/api/clientes \
  -H "Content-Type: application/json" \
  -d '{"telefono":"+5491155443322","tipo":"food_service","nombre":"Restaurante El Puerto","empresa":"El Puerto SRL","zona":"Palermo"}'

curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"telefono":"+5491155443322","mensaje":"Buenos días, qué tienen para hoy?"}'
```

---

## API del Panel de Control

### Clientes
```
GET    /api/clientes              → Lista todos
GET    /api/clientes?tipo=mayorista → Filtra por tipo
POST   /api/clientes              → Crear cliente (mayorista/food_service)
PATCH  /api/clientes/:telefono    → Editar datos
```

### Pedidos
```
GET    /api/pedidos                          → Todos los pedidos
GET    /api/pedidos?tipo_cliente=mayorista   → Filtrar
GET    /api/pedidos?estado=pendiente         → Por estado
GET    /api/pedidos?fecha=2025-03-14         → Por fecha
PATCH  /api/pedidos/:id                      → Actualizar estado
```

### Catálogos
```
GET    /api/catalogo/mayorista    → Ver catálogo actual
GET    /api/catalogo/minorista
GET    /api/catalogo/food_service
POST   /api/catalogo/invalidar    → Forzar recarga desde Sheets
```

### Envío de listados
```
POST   /api/enviar-listado        → body: { "tipo": "mayorista" }
POST   /api/enviar-listado        → body: { "tipo": "food_service" }
```

---

## Etapas de desarrollo

- ✅ **Etapa 1** — Router + 3 agentes + Google Sheets + base de datos
- 🔲 **Etapa 2** — Panel web visual (HTML/JS para operar sin curl)
- 🔲 **Etapa 3** — WhatsApp real con Twilio + envío masivo de listados
- 🔲 **Etapa 4** — Mercado Pago para minoristas + confirmación de horarios food service
