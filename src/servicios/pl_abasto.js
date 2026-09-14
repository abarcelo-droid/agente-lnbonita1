// src/servicios/pl_abasto.js
// ══ P&L ABASTO: LAS REGLAS, SIN BASE DE DATOS ═══════════════════════════════════
//
// Pablo, 12/9/2026: «dentro de Informes vamos a agregar un submódulo que se llama P&L
// Abasto... voy a subir un Excel con el libro diario que nos trae el otro sistema para
// poder ir llevando los resultados de la empresa por aquí».
//
// Acá viven las reglas que no dependen de la base —qué rubros hay, a cuál va una cuenta
// que nadie clasificó, qué renglón de un libro diario se acepta— para que la ruta, la
// pantalla y los tests digan lo mismo.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Los seis rubros del cuadro, en el orden en que se leen.
export const RUBROS = [
  { k: 'ventas',             label: 'Ventas',             ico: '💰' },
  { k: 'costos_variables',   label: 'Costos variables',   ico: '📉' },
  { k: 'costos_fijos',       label: 'Costos fijos',       ico: '🏢' },
  { k: 'costos_financieros', label: 'Costos financieros', ico: '🏦' },
  { k: 'impuestos',          label: 'Impuestos',          ico: '🏛️' },
  { k: 'otros',              label: 'Otros',              ico: '📦' },
];
// Lo que no entra al resultado.
export const SIN_ASIGNAR = 'sin_asignar';
const CLAVES = new Set(RUBROS.map((r) => r.k).concat(SIN_ASIGNAR));
export const esRubro = (k) => CLAVES.has(String(k));

// SÓLO LAS CUENTAS DE RESULTADO. Las que empiezan con 1, 2 o 3 son del patrimonio —caja,
// clientes, proveedores, IVA, capital— y no son ni ingreso ni gasto.
export function esCuentaDeResultado(cuenta) {
  const c = String(cuenta == null ? '' : cuenta).trim();
  return /^\d/.test(c) && !/^[123]/.test(c);
}

// ── A QUÉ RUBRO VA UNA CUENTA QUE NADIE CLASIFICÓ ─────────────────────────────
//
// Es el punto de partida, no la decisión: la clasificación la hace Pablo en «Configurar
// rubros» y queda guardada. Sale del plan de cuentas del libro diario de Abasto, donde
// todo el resultado cuelga del 4 y mezcla ingresos con gastos (el 4.1 tiene «VENTAS» y
// también «G - COMPRA MERCADERIA»):
//   · la compra de mercadería y el costo de lo vendido (4.2.01)  → costos variables
//   · intereses y gastos bancarios (4.2.05.02), la diferencia de cambio (4.1.08), los
//     gastos bancarios del cierre de cambio (4.2.06.08), y por su nombre cualquier
//     interés y el rendimiento del FCI                           → costos financieros
//   · los impuestos, por su nombre —también ingresos brutos y los créditos del decreto
//     814 y la ley 27541—                                          → impuestos
//   · el resto del 4.1: ventas, comisiones y fletes ganados, descuentos → ventas, salvo
//     lo que el mismo plan marca como gasto con «G -»
//   · todo lo demás                                               → otros, para repartir
// Lo que queda en Otros cuenta igual para el resultado neto: nada se pierde por no estar
// clasificado todavía.
const IMPUESTO = /(impuesto|imp\.|ingresos br|iibb|sellos|ley 25413|adicional lh|inmobiliario|decreto 814|ley 27541)/i;
export function rubroPorDefecto(cuenta, nombre) {
  const c = String(cuenta == null ? '' : cuenta).trim();
  const n = String(nombre == null ? '' : nombre);
  if (!esCuentaDeResultado(c)) return SIN_ASIGNAR;
  if (c.startsWith('4.2.01') || c.startsWith('4.1.01.01') || /compra mercader/i.test(n)) return 'costos_variables';
  if (c.startsWith('4.2.05.02') || c.startsWith('4.1.08') || c.startsWith('4.2.06.08')
      || /inter[eé]s|rendimiento fci/i.test(n)) return 'costos_financieros';
  if (IMPUESTO.test(n)) return 'impuestos';
  if (c.startsWith('4.1')) return /^G\s*-/i.test(n.trim()) ? 'otros' : 'ventas';
  return 'otros';
}

// ── ¿ES EL ARCHIVO QUE CORRESPONDE? ───────────────────────────────────────────
//
// Reemplazar un período es BORRAR lo que había, y no hay deshacer. Un libro diario de otra
// empresa, o uno recortado, se delata solo: trae menos renglones de los que borra, o le
// cambia el nombre a varias cuentas que ya se conocían. En esos casos se pide confirmar.
// (Lo encontró la revisión: subir el diario de otra empresa encima del de Abasto borraba
// 78 mil renglones, dejaba 13 mil y le cambiaba el nombre a 22 cuentas, sin decir nada.)
export const NOMBRES_DISTINTOS_MAX = 5;
export function avisosDeReemplazo(r) {
  const x = r || {};
  const avisos = [];
  if (Number(x.existentes) > 0 && Number(x.entran) < Number(x.existentes)) {
    avisos.push('el archivo trae ' + x.entran + ' renglones y reemplaza ' + x.existentes
      + ' que ya estaban cargados de ese período');
  }
  if (Number(x.distintos) > NOMBRES_DISTINTOS_MAX) {
    avisos.push(x.distintos + ' cuentas que ya estaban cargadas tienen otro nombre en este archivo');
  }
  return avisos;
}

// ── UNA CARGA DEL LIBRO DIARIO, VALIDADA ─────────────────────────────────────
//
// La pantalla lee el Excel y manda los renglones ya ordenados: [fecha, asiento, cuenta,
// debe, haber], más el nombre de cada cuenta. El servidor no confía: cada renglón se
// vuelve a mirar, y uno mal formado frena la carga entera. Mejor eso que un resultado
// armado con la mitad de un mes.
export const MAX_RENGLONES = 500000;
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const CUENTA = /^\d+(\.\d+)*$/;
export function validarCarga(body) {
  const b = body || {};
  const filas = Array.isArray(b.renglones) ? b.renglones : null;
  if (!filas || !filas.length) return { error: 'El archivo no trae renglones de asientos.' };
  if (filas.length > MAX_RENGLONES) {
    return { error: 'Son demasiados renglones para una sola carga (' + filas.length + '). Subilo en partes.' };
  }
  const nombres = (b.cuentas && typeof b.cuentas === 'object') ? b.cuentas : {};
  const renglones = [];
  let desde = null, hasta = null, debe = 0, haber = 0;
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    const mal = (que) => ({ error: 'El renglón ' + (i + 1) + ' ' + que + '. No se guardó nada.' });
    if (!Array.isArray(f)) return mal('no tiene la forma esperada');
    const [fecha, asiento, cuenta, d, h] = f;
    const m = FECHA.exec(String(fecha == null ? '' : fecha));
    if (!m || +m[1] < 2000 || +m[1] > 2100 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) {
      return mal('tiene una fecha que no se entiende');
    }
    const c = String(cuenta == null ? '' : cuenta).trim();
    if (!CUENTA.test(c) || c.length > 40) return mal('tiene una cuenta que no se entiende');
    const vd = d == null || d === '' ? 0 : Number(d);
    const vh = h == null || h === '' ? 0 : Number(h);
    if (!Number.isFinite(vd) || !Number.isFinite(vh)) return mal('tiene un importe que no es un número');
    if (!vd && !vh) continue;
    renglones.push({ fecha: m[0], mes: m[0].slice(0, 7),
      asiento: asiento == null ? '' : String(asiento).trim().slice(0, 30), cuenta: c, debe: vd, haber: vh });
    if (!desde || m[0] < desde) desde = m[0];
    if (!hasta || m[0] > hasta) hasta = m[0];
    debe += vd;
    haber += vh;
  }
  if (!renglones.length) return { error: 'El archivo no trae importes: todos los renglones están en cero.' };
  const cuentas = {};
  for (const r of renglones) {
    if (!(r.cuenta in cuentas)) cuentas[r.cuenta] = String(nombres[r.cuenta] || '').trim().slice(0, 120) || r.cuenta;
  }
  return { renglones, cuentas, desde, hasta, debe: r2(debe), haber: r2(haber) };
}

// ── LO QUE NO BALANCEA ────────────────────────────────────────────────────────
//
// Pablo, 14/9/2026: «esto de que el asiento no balancea es perfecto, necesito que me lo
// agregues como una solapa, con el detalle de todo lo que no balancea».
//
// En el libro diario del otro sistema un tercio de los asientos no cierra solo, y casi
// todos por la misma razón: la operación quedó partida en DOS números —la compra en uno y
// su pago en otro, el mismo día— y cada mitad compensa exactamente a la otra. Eso no es un
// error, y listarlo tapaba lo que sí lo es. En diario091426.xls: 2.746 asientos que no
// cierran, 2.664 de a pares; la diferencia de −$22,7 millones la explican los 82 que
// quedan solos, en 35 días. (Y el mismo archivo lo confirma: al final de cada día imprime
// la diferencia del día, y esas 72 cifras suman justo la del archivo.)
//
// Por eso lo que no balancea se mira POR DÍA, y adentro de cada día se apartan las parejas
// —dos asientos con diferencias opuestas al centavo—. Los que quedan sin pareja suman la
// diferencia del día, a lo sumo con unos centavos de redondeo: el archivo trae cuatro
// decimales y cada asiento se redondea al centavo (en el diario de abril, 6 días de 199).
export function asientosSinPareja(asientos) {
  const libres = new Map();
  let emparejados = 0;
  const orden = (asientos || []).slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))
    || String(a.asiento).localeCompare(String(b.asiento), undefined, { numeric: true }));
  for (const x of orden) {
    const centavos = Math.round((Number(x.debe) - Number(x.haber)) * 100);
    if (!centavos) continue;
    const opuestos = libres.get(x.fecha + '|' + -centavos);
    if (opuestos && opuestos.length) {
      opuestos.shift();
      emparejados += 2;
      continue;
    }
    const k = x.fecha + '|' + centavos;
    if (!libres.has(k)) libres.set(k, []);
    libres.get(k).push(x);
  }
  const solos = [].concat(...libres.values());
  // Del día más nuevo al más viejo, y adentro del día la diferencia más grande arriba.
  solos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))
    || Math.abs(b.debe - b.haber) - Math.abs(a.debe - a.haber));
  return { solos, emparejados };
}

// ── UN AJUSTE MANUAL ──────────────────────────────────────────────────────────
//
// Lo que el libro diario no trae y el resultado tiene que mostrar —una amortización, un
// sueldo que se paga por fuera, una provisión— se carga a mano en un rubro, mes por mes, Y
// CON EL SIGNO CON QUE PESA en el resultado: un gasto en negativo, un ingreso en positivo.
// Así entra a la cascada como una cuenta más, sin reglas aparte.
//
// Vacío o cero en un mes es SACAR el importe de ese mes: vuelve null.
const MES_AJUSTE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const AJUSTE_MESES_MAX = 36;
export function validarAjuste(body) {
  const b = body || {};
  const nombre = String(b.nombre == null ? '' : b.nombre).trim().replace(/\s+/g, ' ');
  if (!nombre) return { error: 'Falta el nombre del ajuste.' };
  if (nombre.length > 80) return { error: 'El nombre del ajuste es muy largo: hasta 80 letras.' };
  const rubro = String(b.rubro == null ? '' : b.rubro);
  // Uno de los seis: un ajuste «sin asignar» no entraría a ningún lado.
  if (!RUBROS.some((r) => r.k === rubro)) return { error: 'Elegí a qué rubro va el ajuste.' };
  const entrada = (b.meses && typeof b.meses === 'object' && !Array.isArray(b.meses)) ? b.meses : null;
  if (!entrada) return { error: 'Faltan los importes del ajuste.' };
  const claves = Object.keys(entrada);
  if (claves.length > AJUSTE_MESES_MAX) return { error: 'Son demasiados meses para guardar de una vez.' };
  const meses = {};
  for (const m of claves) {
    if (!MES_AJUSTE.test(m)) return { error: 'Ese mes no se entiende: ' + m + '.' };
    const v = entrada[m];
    if (v == null || v === '') { meses[m] = null; continue; }
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isFinite(n) || Math.abs(n) >= 1e13) {
      return { error: 'El importe de ' + m + ' no es un número.' };
    }
    meses[m] = r2(n) || null;
  }
  return { nombre, rubro, meses };
}
