// src/servicios/fp_motor.js
// ── Motor de proyección de flujo de fondos ────────────────────────────────
// Funciones puras: entra el estado de la base, sale la grilla. Sin acceso a DB
// (el router hace las consultas), así que se puede probar sin levantar nada.
//
// LA CUENTA, QUE ES LO ÚNICO IMPORTANTE:
//
//     saldo_acumulado(semana n) = saldo_inicial + Σ (ingresos − egresos) hasta n
//
// El saldo inicial entra UNA VEZ. En la planilla los saldos de banco están
// sumados dentro de "TOTAL INGRESOS" y esa fila se acumula semana a semana, así
// que el mismo saldo se cuenta de nuevo cada vez. La prueba está en Supervielle:
// 457,70 repetido cuatro semanas seguidas — una cuenta no recibe exactamente
// 457,70 todas las semanas, es un saldo quieto — y termina aportando 3.425,65 a
// un acumulado que no significa nada.
//
// Todo a 2 decimales. La plata se compara y se suma; los flotantes sin redondear
// dan diferencias de centavos que después nadie sabe de dónde salen.

const MS_DIA = 86400000;

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Fechas ────────────────────────────────────────────────────────────────
// Todo en UTC a propósito: con hora local, un lunes a las 00:00 en una zona con
// horario de verano puede caer en domingo y correr la semana entera.

function aUTC(fecha) {
  if (fecha instanceof Date) return new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
export const iso = (d) => d.toISOString().slice(0, 10);

/** El lunes de la semana que contiene esa fecha. */
export function lunesDe(fecha) {
  const d = aUTC(fecha);
  if (!d) return null;
  const dow = d.getUTCDay();                 // 0 domingo … 6 sábado
  const atras = (dow === 0) ? 6 : dow - 1;   // el domingo pertenece a la semana que arrancó el lunes
  return iso(new Date(d.getTime() - atras * MS_DIA));
}

/** Los lunes de `n` semanas consecutivas a partir de la que contiene `desde`. */
export function semanasDesde(desde, n) {
  const l0 = lunesDe(desde);
  if (!l0) return [];
  const base = aUTC(l0).getTime();
  const out = [];
  for (let i = 0; i < n; i++) out.push(iso(new Date(base + i * 7 * MS_DIA)));
  return out;
}

/**
 * En qué DÍA cae la cuota de un préstamo.
 *
 * El calendario de préstamos es mensual y el flujo es semanal; la columna
 * "Débito" de la planilla (1ª a 4ª semana del mes) es lo que los une, y ese pase
 * hoy se hace a mano.
 *
 * "2ª semana del mes" se toma como los días 8 al 14 — que es lo que entiende
 * una persona — y no como "el segundo lunes". La otra definición se rompe
 * cuando el 1º cae domingo: su lunes está en el mes anterior, y la cuota de
 * mayo terminaría proyectada en abril.
 */
export function diaDeCuota(periodo, semanaDebito) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo || ''));
  if (!m) return null;
  const anio = +m[1], mes = +m[2];
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const n = Math.min(Math.max(parseInt(semanaDebito, 10) || 1, 1), 4);
  const dia = Math.min(1 + (n - 1) * 7, ultimo);
  return iso(new Date(Date.UTC(anio, mes - 1, dia)));
}

// ── Proyección ────────────────────────────────────────────────────────────

/**
 * @param {Object}   e
 * @param {string}   e.desde         fecha de arranque (se lleva a su lunes)
 * @param {number}   e.semanas       cuántas semanas proyectar
 * @param {number}   e.saldoInicial  suma de los saldos de banco al arranque
 * @param {Array}    e.conceptos     filas del flujo (fp_conceptos)
 * @param {Array}    e.valores       carga manual {concepto_id, semana, monto}
 * @param {Array}    e.cuotas        cuotas pendientes {periodo, semana_debito, banco, capital, interes}
 * @param {Array}    e.cheques       cheques pendientes {tipo, banco, fecha_pago, monto}
 */
export function proyectar({ desde, semanas = 13, saldoInicial = 0, conceptos = [], valores = [], cuotas = [], cheques = [] }) {
  const cols = semanasDesde(desde, semanas);
  if (!cols.length) return { ok: false, error: 'Fecha de inicio inválida' };

  const idx = new Map(cols.map((s, i) => [s, i]));
  const primera = cols[0], ultima = cols[cols.length - 1];

  // Un movimiento con fecha ANTERIOR al horizonte no se tira: es una cuota o un
  // cheque que sigue pendiente, o sea plata que igual hay que pagar. Va en la
  // primera semana y se informa aparte en `vencido` para que el número no
  // aparezca sin explicación.
  const vencido = { ingresos: 0, egresos: 0, items: 0 };

  const FUERA = -1;   // más allá del horizonte: no entra, y no es un problema
  function celda(fecha) {
    const l = lunesDe(fecha);
    if (!l) return FUERA;
    if (l < primera) return 0;            // vencido: cae en la primera semana
    if (l > ultima) return FUERA;
    return idx.has(l) ? idx.get(l) : FUERA;
  }
  const esVencido = (fecha) => { const l = lunesDe(fecha); return !!l && l < primera; };

  const ceros = () => new Array(cols.length).fill(0);
  // Sin quitar acentos, un préstamo cargado como "Nación" no matchea la fila
  // "Nacion" y su cuota se pierde. Es el tipo de error que este módulo existe
  // para no volver a cometer.
  const norm = (s) => String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Carga manual indexada por concepto+semana
  const manual = new Map();
  for (const v of valores) manual.set(v.concepto_id + '|' + v.semana, Number(v.monto) || 0);

  const filas = conceptos.map((c) => ({
    concepto_id: c.id, nombre: c.nombre, naturaleza: c.naturaleza,
    origen: c.origen, banco: c.banco || null,
    editable: c.origen === 'manual',
    montos: ceros(),
    detalle: cols.map(() => []),
    total: 0,
  }));
  const filaDe = new Map(filas.map((f, i) => [conceptos[i], f]));

  filas.forEach((f, i) => {
    if (conceptos[i].origen !== 'manual') return;
    cols.forEach((s, j) => { f.montos[j] = Number(manual.get(f.concepto_id + '|' + s)) || 0; });
  });

  /**
   * Cada movimiento va a UNA sola fila: la más específica que lo matchee, y si
   * no hay ninguna con ese banco, la comodín (la que no tiene banco).
   *
   * Se recorre movimiento → fila, y NO fila → movimiento, por dos razones que
   * costaron plata en la planilla:
   *   - al revés, una cuota cuyo banco no coincide con ninguna fila no se suma
   *     en ningún lado y desaparece del total EN SILENCIO. Es el mismo error de
   *     la fila 42 de la planilla, que suma =+N2+N5+N8+… y se olvidó de tres
   *     préstamos: 678 millones afuera;
   *   - y una que coincide con DOS filas se cuenta dos veces.
   * Acá lo que no encuentra fila se reporta en `huerfanos`, y nunca se cuenta doble.
   */
  function elegirFila(candidatos, banco) {
    let exacto = null, comodin = null;
    for (const c of candidatos) {
      if (!c.banco) { if (!comodin) comodin = c; }
      else if (norm(c.banco) === norm(banco) && !exacto) exacto = c;
    }
    return exacto || comodin;
  }

  const huerfanos = { items: 0, monto: 0, bancos: [] };
  const bancosSueltos = new Set();
  function sinFila(banco, monto) {
    huerfanos.items++;
    huerfanos.monto = round2(huerfanos.monto + monto);
    bancosSueltos.add(String(banco || '(sin banco)').trim() || '(sin banco)');
  }

  const cPrestamos = conceptos.filter(c => c.origen === 'prestamos');
  for (const q of cuotas) {
    const dia = diaDeCuota(q.periodo, q.semana_debito);
    const i = celda(dia);
    if (i === FUERA) continue;                      // fuera del horizonte: correcto que no entre
    const monto = round2((Number(q.capital) || 0) + (Number(q.interes) || 0));
    const c = elegirFila(cPrestamos, q.banco);
    if (!c) { sinFila(q.banco, monto); continue; }
    const f = filaDe.get(c);
    f.montos[i] += monto;
    f.detalle[i].push({ tipo: 'cuota', banco: q.banco, numero: q.numero, nro_cuota: q.nro_cuota, periodo: q.periodo, monto });
    if (esVencido(dia)) { vencido.egresos = round2(vencido.egresos + monto); vencido.items++; }
  }

  const cCheques = conceptos.filter(c => c.origen === 'cheques');
  for (const ch of cheques) {
    const i = celda(ch.fecha_pago);
    if (i === FUERA) continue;
    const monto = round2(ch.monto);
    const entra = norm(ch.tipo) === 'recibido';
    const c = elegirFila(cCheques.filter(x => (x.naturaleza === 'ingreso') === entra), ch.banco);
    if (!c) { sinFila(ch.banco, monto); continue; }
    const f = filaDe.get(c);
    f.montos[i] += monto;
    f.detalle[i].push({ tipo: 'cheque', banco: ch.banco, numero: ch.numero, beneficiario: ch.beneficiario, monto });
    if (esVencido(ch.fecha_pago)) {
      if (entra) vencido.ingresos = round2(vencido.ingresos + monto);
      else vencido.egresos = round2(vencido.egresos + monto);
      vencido.items++;
    }
  }

  huerfanos.bancos = [...bancosSueltos].sort();
  for (const f of filas) {
    f.montos = f.montos.map(round2);
    f.total = round2(f.montos.reduce((a, b) => a + b, 0));
  }

  // Los totales salen SOLO de las filas. El vencido ya está adentro de la primera
  // columna de su fila (celda() lo manda al índice 0), así que sumarlo de nuevo
  // acá lo contaría dos veces — y, más importante, la columna dejaría de ser la
  // suma de lo que se ve arriba, que es lo primero que cualquiera verifica a mano.
  const ingresos = ceros(), egresos = ceros();
  for (const f of filas) {
    const acc = f.naturaleza === 'ingreso' ? ingresos : egresos;
    f.montos.forEach((m, i) => { acc[i] += m; });
  }

  const neto = cols.map((_, i) => round2(ingresos[i] - egresos[i]));
  const acumulado = [];
  let corre = round2(saldoInicial);
  for (let i = 0; i < cols.length; i++) { corre = round2(corre + neto[i]); acumulado.push(corre); }

  // Lo que Pablo viene a buscar: la semana en que se queda sin fondos, y el peor
  // momento del horizonte. Con la planilla eso hay que leerlo a ojo en una fila
  // de números que además está mal calculada.
  let quiebre = null;
  for (let i = 0; i < cols.length; i++) if (acumulado[i] < 0) { quiebre = { semana: cols[i], indice: i, saldo: acumulado[i] }; break; }
  let peor = 0;
  for (let i = 1; i < acumulado.length; i++) if (acumulado[i] < acumulado[peor]) peor = i;

  return {
    ok: true,
    desde: cols[0], hasta: cols[cols.length - 1], semanas: cols,
    saldo_inicial: round2(saldoInicial),
    filas,
    ingresos: ingresos.map(round2),
    egresos: egresos.map(round2),
    neto,
    acumulado,
    quiebre,
    minimo: { semana: cols[peor], indice: peor, saldo: acumulado[peor] },
    vencido: { ingresos: round2(vencido.ingresos), egresos: round2(vencido.egresos), items: vencido.items },
    // Plata que cae dentro del horizonte pero cuyo banco no coincide con ninguna
    // fila. Se informa SIEMPRE, aunque sea cero: un flujo de fondos donde algo
    // puede evaporarse sin aviso no sirve para decidir nada.
    huerfanos,
  };
}

// ── Generador de cuotas ───────────────────────────────────────────────────
// Para cargar un préstamo sin tipear 24 filas. Los tres sistemas de la hoja
// "Tabla Referencias". La TNA se pasa como decimal anual (0.41 = 41%).

export function generarCuotas({ sistema, monto, cuotas, tna, periodoInicio }) {
  const n = Math.max(parseInt(cuotas, 10) || 0, 0);
  const cap = Number(monto) || 0;
  if (!n || !cap) return [];
  const i = (Number(tna) || 0) / 12;             // tasa mensual simple
  const out = [];
  let saldo = cap;

  for (let k = 1; k <= n; k++) {
    let capital, interes;
    if (sistema === 'cuota_unica') {
      capital = (k === n) ? cap : 0;
      interes = round2(saldo * i);
    } else if (sistema === 'aleman') {
      capital = round2(cap / n);
      interes = round2(saldo * i);
    } else {                                      // francés (el default de la planilla)
      const cuota = i > 0 ? cap * i / (1 - Math.pow(1 + i, -n)) : cap / n;
      interes = round2(saldo * i);
      capital = round2(cuota - interes);
    }
    // La última cuota cancela el saldo: sin esto quedan centavos vivos para siempre.
    if (k === n) capital = round2(saldo);
    saldo = round2(saldo - capital);
    out.push({ nro_cuota: k, periodo: sumarMeses(periodoInicio, k - 1), capital: round2(capital), interes: round2(interes) });
  }
  return out;
}

export function sumarMeses(periodo, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + (parseInt(n, 10) || 0), 1));
  return d.toISOString().slice(0, 7);
}
