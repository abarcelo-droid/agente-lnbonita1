// src/servicios/diagnostico_contable.js
// ── CUÁNTA CONTABILIDAD DE CADA EMPRESA HAY EN LAS TABLAS COMPARTIDAS ──────
//
// PARA QUÉ ES
// El pedido es que cada sociedad tenga sus propias tablas contables. Antes de
// mover un solo asiento hay que saber QUÉ hay adentro: cuántos asientos son de
// cada empresa, si alguno quedó mezclado, y si la numeración de los libros ya
// tiene huecos. Mover datos contables sin ese número es adivinar.
//
// SOLO CUENTA. No hay un solo INSERT, UPDATE ni DELETE en este archivo, y el
// script que lo usa desde afuera abre la base en modo readonly para que no pueda
// haberlo ni por accidente.
//
// UNA SOLA COPIA DEL INFORME
// Esto es una función que recibe la base y devuelve texto, en vez de un script
// que imprime. Así el mismo informe sale por dos lados —el comando de consola y
// la pantalla del panel— sin que existan dos versiones que con el tiempo dicen
// cosas distintas.
//
// QUÉ MIRA, Y POR QUÉ CADA COSA
//   1. Reparto por empresa — el número que decide el tamaño de la mudanza.
//   2. Asientos que usan cuentas de OTRA empresa — el cruce invisible. Las
//      líneas del asiento no tienen empresa propia: la heredan de la cabecera,
//      pero apuntan a un plan de cuentas que sí la tiene. Un asiento de San
//      Gerónimo imputado a una cuenta de Puente Cordón no se ve en ninguna
//      pantalla y ensucia los dos balances a la vez.
//   3. Huecos en el correlativo — el daño que el número compartido ya dejó
//      hecho en los libros (arreglado para lo que viene, en el PR #624).
//   4. Tablas contables sin marca de empresa — dónde falta la separación.

// Tablas contables compartidas que ya llevan la marca de empresa.
const COMPARTIDAS = [
  ['pa_asientos',              'Asientos contables'],
  ['pa_cuentas',               'Plan de cuentas'],
  ['pa_cuentas_secciones',     'Secciones del plan'],
  ['pa_movimientos_contables', 'Movimientos contables'],
  ['adm_proveedores',          'Proveedores'],
  ['pa_pagos_proveedores',     'Pagos a proveedores'],
  ['fin_cuentas',              'Cuentas de caja y banco'],
  ['fin_movimientos',          'Movimientos de caja y banco'],
  ['fin_ordenes_pago',         'Órdenes de pago'],
  ['fin_cheques_propios',      'Cheques propios'],
  ['fin_cheques_terceros',     'Cheques de terceros'],
  ['ven_facturas',             'Facturas de venta'],
  ['ven_clientes',             'Clientes'],
];

// Tablas hijas: no necesitan la marca porque la heredan del padre y se separan
// solas cuando se separa la cabecera. Listarlas como "sin empresa" sería ruido.
const HIJAS = new Set([
  'pa_asientos_lineas', 'pa_compras_items', 'pa_ordenes_items', 'pa_ordenes_lotes',
  'adm_asientos_modelo_lineas', 'fin_op_compras', 'fin_extracto_lineas',
  'pa_liquidaciones_items', 'pa_cuentas_titulos', 'pa_cuentas_log',
]);

export function informeContable(db) {
  const L = [];
  const w = (s = '') => L.push(s);
  const raya = (c = '─') => w('  ' + c.repeat(74));
  const titulo = (t) => { w(); raya('═'); w('  ' + t); raya('═'); };

  const existe = (t) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const columnas = (t) => (existe(t) ? db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name) : []);
  const contar = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

  w();
  w('  DIAGNÓSTICO CONTABLE POR SOCIEDAD — solo lectura, no modifica nada');

  // ── Las empresas ────────────────────────────────────────────────────────
  const socs = existe('sociedades')
    ? db.prepare('SELECT id, nombre, activa FROM sociedades ORDER BY id').all()
    : [];
  const nombreSoc = (id) => {
    const s = socs.find(x => x.id === id);
    return s ? s.nombre : `(id ${id} — NO EXISTE en sociedades)`;
  };

  titulo('EMPRESAS');
  if (!socs.length) {
    w('  No hay tabla `sociedades`. El resto del informe no tiene con qué comparar.');
  } else {
    for (const s of socs) w(`  ${String(s.id).padStart(3)}  ${s.nombre}${s.activa ? '' : '   (inactiva)'}`);
  }

  // ── 1. EL REPARTO: cuánto es de cada una ────────────────────────────────
  titulo('1. CUÁNTA CONTABILIDAD HAY DE CADA EMPRESA');

  const repartos = [];
  for (const [t, etiqueta] of COMPARTIDAS) {
    if (!existe(t)) continue;
    const total = contar(t);
    if (!columnas(t).includes('sociedad_id')) {
      repartos.push({ t, etiqueta, total, sinColumna: true, filas: [] });
      continue;
    }
    const filas = db.prepare(
      `SELECT sociedad_id s, COUNT(*) c FROM ${t} GROUP BY sociedad_id ORDER BY c DESC`).all();
    repartos.push({ t, etiqueta, total, sinColumna: false, filas });
  }

  if (!repartos.length) w('  No existe ninguna de las tablas contables conocidas en esta base.');
  for (const r of repartos) {
    const cab = `  ${r.etiqueta.padEnd(28)} ${String(r.total).padStart(7)} fila(s)`;
    if (r.sinColumna) { w(cab + '   ← SIN marca de empresa'); continue; }
    if (!r.total) { w(cab + '   (vacía)'); continue; }
    w(cab);
    for (const f of r.filas) {
      const pct = Math.round((f.c / r.total) * 100);
      w(`      ${String(f.c).padStart(7)}  ${String(pct).padStart(3)}%  ${nombreSoc(f.s)}`);
    }
  }

  // ── 2. EL CRUCE INVISIBLE ───────────────────────────────────────────────
  titulo('2. ASIENTOS IMPUTADOS A CUENTAS DE OTRA EMPRESA');
  w('  Las líneas del asiento no llevan empresa: la heredan de la cabecera. Pero');
  w('  apuntan a un plan de cuentas que sí la tiene. Si no coinciden, ese asiento');
  w('  ensucia los dos balances y no se ve en ninguna pantalla.');
  w();

  let cruces = 0;
  if (existe('pa_asientos_lineas') && columnas('pa_asientos').includes('sociedad_id')
      && columnas('pa_cuentas').includes('sociedad_id')) {
    const malas = db.prepare(`
      SELECT a.sociedad_id AS soc_asiento, c.sociedad_id AS soc_cuenta, COUNT(*) AS c
        FROM pa_asientos_lineas l
        JOIN pa_asientos a ON a.id = l.asiento_id
        JOIN pa_cuentas  c ON c.id = l.cuenta_id
       WHERE a.sociedad_id <> c.sociedad_id
       GROUP BY a.sociedad_id, c.sociedad_id`).all();
    cruces = malas.reduce((n, m) => n + m.c, 0);
    if (!cruces) {
      w('  Ninguno. Cada asiento usa cuentas de su propia empresa.');
    } else {
      for (const m of malas) {
        w(`  ${String(m.c).padStart(6)} línea(s): asiento de ${nombreSoc(m.soc_asiento)}`);
        w(`          imputado a cuentas de ${nombreSoc(m.soc_cuenta)}`);
      }
      w();
      w('  Estos hay que revisarlos UNO POR UNO antes de mover nada: no se puede');
      w('  decidir por programa a qué empresa pertenece un asiento así.');
      const ej = db.prepare(`
        SELECT a.id, a.fecha, a.descripcion
          FROM pa_asientos_lineas l
          JOIN pa_asientos a ON a.id = l.asiento_id
          JOIN pa_cuentas  c ON c.id = l.cuenta_id
         WHERE a.sociedad_id <> c.sociedad_id
         GROUP BY a.id ORDER BY a.fecha DESC LIMIT 10`).all();
      w();
      w('  Los más recientes:');
      for (const e of ej) w(`   · #${e.id}  ${e.fecha}  ${String(e.descripcion || '').slice(0, 46)}`);
    }
  } else {
    w('  No se puede medir: falta pa_asientos_lineas o la marca de empresa.');
  }

  // ── 3. HUECOS EN EL CORRELATIVO ─────────────────────────────────────────
  titulo('3. HUECOS EN LA NUMERACIÓN DE CADA LIBRO');
  w('  Hasta el arreglo del PR #624 las tres empresas compartían una sola serie de');
  w('  números, así que cada libro quedó salteado. Esto mide el daño ya hecho: de');
  w('  acá en adelante no se generan huecos nuevos.');
  w();

  if (existe('pa_asientos') && columnas('pa_asientos').includes('ref_codigo')
      && columnas('pa_asientos').includes('sociedad_id')) {
    const series = db.prepare(`
      SELECT sociedad_id s, substr(ref_codigo, 1, 8) serie, COUNT(*) c
        FROM pa_asientos
       WHERE ref_codigo LIKE 'FAC-____-%'
       GROUP BY s, serie ORDER BY serie, s`).all();
    if (!series.length) {
      w('  No hay asientos con numeración FAC-AAAA-NNNN todavía.');
    } else {
      for (const s of series) {
        const nums = db.prepare(`
          SELECT CAST(substr(ref_codigo, 10) AS INTEGER) n FROM pa_asientos
           WHERE sociedad_id = ? AND ref_codigo LIKE ? ORDER BY n`).all(s.s, s.serie + '-%')
          .map(r => r.n).filter(n => n > 0);
        if (!nums.length) continue;
        // Un Set y no `nums.includes(i)`: con varios miles de asientos por empresa,
        // buscar dentro del arreglo en cada vuelta hace que el informe tarde minutos.
        const hay = new Set(nums);
        const faltan = [];
        for (let i = nums[0]; i <= nums[nums.length - 1]; i++) if (!hay.has(i)) faltan.push(i);
        w(`  ${s.serie}  ${nombreSoc(s.s)}`);
        w(`      ${nums.length} asiento(s), del ${nums[0]}–${nums[nums.length - 1]}` +
          (faltan.length
            ? `  → FALTAN ${faltan.length}: ${faltan.slice(0, 14).join(', ')}${faltan.length > 14 ? '…' : ''}`
            : '  → sin huecos'));
      }
    }
  } else {
    w('  pa_asientos no tiene ref_codigo o no tiene marca de empresa.');
  }

  // ── 4. TABLAS CONTABLES SIN MARCA DE EMPRESA ────────────────────────────
  titulo('4. TABLAS CONTABLES SIN MARCA DE EMPRESA');
  w('  Las que tienen datos y no distinguen empresa son las que hoy están de verdad');
  w('  compartidas. Las hijas (líneas, ítems) no necesitan la marca: la heredan del');
  w('  padre y se separan solas cuando se separa la cabecera.');
  w();

  const contables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
     AND (name LIKE 'pa\\_%' ESCAPE '\\' OR name LIKE 'adm\\_%' ESCAPE '\\'
       OR name LIKE 'fin\\_%' ESCAPE '\\')
     ORDER BY name`).all().map(r => r.name);

  const sinMarca = [];
  for (const t of contables) {
    if (columnas(t).includes('sociedad_id')) continue;
    const n = contar(t);
    if (!n) continue;
    sinMarca.push({ t, n, hija: HIJAS.has(t) });
  }
  const propias = sinMarca.filter(x => !x.hija);
  const hijas = sinMarca.filter(x => x.hija);

  if (!propias.length) {
    w('  Todas las tablas contables con datos propios distinguen empresa.');
  } else {
    w('  CON DATOS Y SIN DISTINGUIR EMPRESA:');
    for (const x of propias) w(`   · ${x.t.padEnd(34)} ${String(x.n).padStart(7)} fila(s)`);
  }
  if (hijas.length) {
    w();
    w('  Hijas (heredan del padre, está bien que no la tengan):');
    w('   ' + hijas.map(x => x.t).join(', '));
  }

  // ── RESUMEN ─────────────────────────────────────────────────────────────
  titulo('EN UNA LÍNEA');
  const asi = repartos.find(r => r.t === 'pa_asientos');
  if (asi && asi.filas.length > 1) {
    w(`  Hay contabilidad de ${asi.filas.length} empresas en la misma tabla de asientos.`);
  } else if (asi && asi.filas.length === 1) {
    w(`  Todos los asientos (${asi.total}) son de ${nombreSoc(asi.filas[0].s)}: la mudanza es`);
    w('  renombrar, no repartir. Es el caso más simple posible.');
  }
  w(cruces
    ? `  ${cruces} línea(s) cruzan empresas y hay que revisarlas a mano ANTES de mover nada.`
    : '  Ningún asiento usa cuentas de otra empresa: los datos NO están volcados juntos.');
  w(propias.length
    ? `  ${propias.length} tabla(s) contable(s) con datos todavía no distinguen empresa.`
    : '  Toda tabla contable con datos propios distingue empresa.');
  w();
  w('  Esto es el paso 1 (medir). No modificó nada.');
  w();

  return L.join('\n');
}
