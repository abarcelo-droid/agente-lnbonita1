// src/servicios/storage.js
// ── Almacenamiento persistente en Cloudflare R2 (S3-compatible) ───────────────────
// Reusable por cualquier módulo. Introducido por Importación F6 (expediente documental
// del embarque). A diferencia de los uploads de IFCO (disco EFÍMERO del contenedor, que
// se pierden en cada redeploy y por eso IFCO borra el archivo tras el OCR), acá los
// archivos viven en R2 → persisten entre redeploys de Railway.
//
// Credenciales en env (ya cargadas en Railway): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET.
//
// DISEÑO: NO se cae la app al bootear si faltan las env vars (rompería todo el panel en
// entornos sin R2). En cambio, el cliente se crea LAZY y cualquier operación falla EXPLÍCITO
// con un error claro (nunca hay fallback silencioso a disco, que perdería archivos). Los
// endpoints chequean storageConfigurado() antes de operar y devuelven 503 si no está.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

let _client = null;

// true si las 4 credenciales están presentes. Los endpoints lo usan para cortar temprano.
export function storageConfigurado() {
  return ENV_KEYS.every(k => !!process.env[k]);
}

// Cliente S3 apuntando a R2. Lazy: se crea en el primer uso. Si faltan credenciales, TIRA
// un error explícito (no fallback a disco). Se cachea para no recrearlo en cada request.
function getClient() {
  if (_client) return _client;
  const faltan = ENV_KEYS.filter(k => !process.env[k]);
  if (faltan.length) throw new Error('Almacenamiento R2 no configurado: faltan env vars ' + faltan.join(', '));
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  return _client;
}

// Sube un buffer a R2 bajo la key dada. Devuelve la key (para persistir en la DB).
export async function subirArchivo(buffer, key, mime) {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: key, Body: buffer, ContentType: mime || 'application/octet-stream'
  }));
  return key;
}

// Obtiene un archivo de R2. Devuelve el Body (Readable stream de Node) para hacer proxy/pipe.
export async function obtenerArchivo(key) {
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  return res.Body;   // Node.js Readable stream
}

// Borra un archivo de R2. F6 NO lo usa (el expediente se conserva: soft delete en la DB),
// pero queda disponible para otros módulos.
export async function borrarArchivo(key) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}
