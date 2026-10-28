// ══ UN INSUMO QUE LA RECETA USA Y NO ESTÁ EN LA LISTA DICE POR QUÉ ═════════
//
// Pablo, 28/10/2026: «creé un insumo nuevo, y está en el plan… ¿por qué no me aparece para
// comprar?». Era ESQUINERO 2 MTS, cargado en la receta de MELÓN BLANCO › CAJA GRANDE. El plan
// estaba CONFIRMADO, y un plan confirmado guarda sus números congelados: lo que se agrega a una
// receta después no entra. Eso está bien y no se toca — es la única defensa contra «el plan que
// mandé a comprar cambió solo porque alguien editó una receta».
//
// Lo que estaba mal es que no lo decía NADIE. La lista simplemente no lo tenía, y desde la
// pantalla un insumo que está en la receta y no está en la lista se lee igual que un error del
// sistema.
//
// Este archivo corre las dos piezas DE VERDAD: el motor (`calcularPlan`, que es puro) y la función
// `fueraDelPlan` del router, sacada del archivo y ejecutada con una base SQLite real. Y además
// ejecuta el bloque del panel contra los datos que el backend manda, así que lo que se mide es el
// HTML que ve el operador, no que el código mencione una variable.
//
// El fixture es el caso de Pablo: los tres insumos de esa receta, con sus unidades reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/planificacion.js');
const DDL = leer('src/servicios/db_pli.js');
const PANEL = leer('src/panel.html');
const MOTOR = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/pli_motor.js')));
const { calcularPlan, MODO_TEXTO } = MOTOR;

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// ── La base: sólo pli_insumos, que es la única tabla que toca fueraDelPlan ──
function base() {
  const db = new DatabaseSync(':memory:');
  const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS pli_insumos (');
  assert.ok(i >= 0, 'no está la tabla pli_insumos');
  db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  for (const m of DDL.match(/addCol\('pli_insumos',\s*'[a-z_]+',\s*'[^']+'\)/g) || []) {
    const [, col, tipo] = /addCol\('pli_insumos',\s*'([a-z_]+)',\s*'([^']+)'\)/.exec(m);
    if (!db.prepare('PRAGMA table_info(pli_insumos)').all().map((c) => c.name).includes(col)) {
      db.exec(`ALTER TABLE pli_insumos ADD COLUMN ${col} ${tipo}`);
    }
  }
  const ins = db.prepare(`INSERT INTO pli_insumos (id, sociedad_id, nombre, unidad_compra,
    unidad_uso, factor_compra, multiplo_compra, stock_inicial, lead_time_dias, modo_provision,
    eliminado_en) VALUES (?,1,?,?,?,?,?,0,?,?,?)`);
  ins.run(1, 'CAJA GRANDE 600*400*180', 'MILLAR', 'unidad', 1000, 10, 15, 'compra', null);
  ins.run(2, 'PALLETS', 'UN', 'unidad', 1, 1, 24, 'compra', null);
  ins.run(3, 'ESQUINERO 2 MTS', 'UN', '1', 11, 1, 0, 'compra', null);
  return db;
}

// `fueraDelPlan` tal como está escrita en el router, con sus dependencias inyectadas.
// `armarContexto` es el único stub: lo que devuelve es el plan de HOY, que es justamente
// lo que cada prueba necesita controlar.
function cargarFueraDelPlan(db, ctxDeHoy) {
  const src = fuente(RUTA, 'function fueraDelPlan(soc, plan, lineas, vivo)');
  const f = new Function('calcularPlan', 'armarContexto', 'db', 'MODO_TEXTO',
    src + '\nreturn fueraDelPlan;')(calcularPlan, () => ctxDeHoy, db, MODO_TEXTO);
  return (lineas, vivo) => f(1, { id: 7, estado: 'confirmado' }, lineas, vivo);
}

// ── El fixture: la receta de MELÓN BLANCO › CAJA GRANDE, con los tres insumos ──
const INSUMOS = new Map([
  [1, { id: 1, nombre: 'CAJA GRANDE 600*400*180', unidad_compra: 'MILLAR', unidad_uso: 'unidad',
        factor_compra: 1000, multiplo_compra: 10, moq: 0, lead_time_dias: 15,
        modo_provision: 'compra', precio_ref: 1811.3, moneda: 'ARS' }],
  [2, { id: 2, nombre: 'PALLETS', unidad_compra: 'UN', unidad_uso: 'unidad', factor_compra: 1,
        multiplo_compra: 1, moq: 0, lead_time_dias: 24, modo_provision: 'compra',
        precio_ref: 9500, moneda: 'ARS' }],
  // Unidad de uso «1» y equivalencia 1 UN = 11: son los valores con los que Pablo lo cargó.
  [3, { id: 3, nombre: 'ESQUINERO 2 MTS', unidad_compra: 'UN', unidad_uso: '1', factor_compra: 11,
        multiplo_compra: 1, moq: 0, lead_time_dias: 0, modo_provision: 'compra',
        precio_ref: 0, moneda: 'ARS' }]
]);

const PRODUCTOS = [
  { id: 1, padre_id: null, nombre: 'MELON BLANCO', unidad: 'caja', activo: 1, orden: 1,
    modo_reparto: 'particiona', share_pct: 0, receta_version: 1 },
  { id: 2, padre_id: 1, nombre: 'CAJA GRANDE', unidad: 'caja', activo: 1, orden: 1,
    modo_reparto: 'particiona', share_pct: 100, receta_version: 14 }
];

// Las tres líneas de la receta, tal cual la pantalla las muestra.
const RECETA = [
  { producto_id: 2, insumo_id: 1, cantidad: 1, por_cada: 1, unidad: 'unidad', merma_pct: 0, orden: 1 },
  { producto_id: 2, insumo_id: 2, cantidad: 1, por_cada: 55, unidad: 'unidad', merma_pct: 0, orden: 2 },
  { producto_id: 2, insumo_id: 3, cantidad: 4, por_cada: 55, unidad: '1', merma_pct: 0, orden: 3 }
];

function ctx({ insumos = INSUMOS, receta = RECETA, productos = PRODUCTOS } = {}) {
  return {
    plan: { id: 7 },
    productos,
    objetivos: [{ producto_id: 1, cantidad: 11000, unidad: 'caja', bucket_ini: '2026-11-02' }],
    recetas: new Map([[2, receta]]),
    insumos,
    existencias: new Map(),
    comprado: new Map()
  };
}

// Lo que quedó congelado el día que se confirmó: los dos insumos que ya existían.
const CONGELADAS = [{ insumo_id: 1 }, { insumo_id: 2 }];

// ══════════════════════════════════════════════════════════════════════════
// EL CASO DE PABLO
// ══════════════════════════════════════════════════════════════════════════

test('el insumo que entró a la receta después de confirmar sale nombrado, no en silencio', () => {
  // Primero: el motor de HOY sí lo necesita. Si esto fallara, el problema sería otro.
  const hoy = calcularPlan(ctx());
  const l = hoy.lineas.find((x) => x.insumo_id === 3);
  assert.ok(l, 'la receta de hoy tendría que necesitar el ESQUINERO');
  assert.ok(l.bultos_a_comprar > 0, 'y tendría que mandar a comprar algo');

  const fuera = cargarFueraDelPlan(base(), ctx())(CONGELADAS);
  assert.equal(fuera.length, 1, 'tendría que avisar por exactamente un insumo');
  assert.equal(fuera[0].insumo_id, 3);
  assert.equal(fuera[0].insumo, 'ESQUINERO 2 MTS');
  assert.equal(fuera[0].motivo, 'receta_nueva');
});

test('los que SÍ están en la lista congelada no se avisan', () => {
  const fuera = cargarFueraDelPlan(base(), ctx())(CONGELADAS);
  assert.equal(fuera.filter((f) => f.insumo_id === 1 || f.insumo_id === 2).length, 0);
});

test('un insumo del plan con nada pendiente NO es un insumo que falta', () => {
  // Está en la lista congelada aunque el stock lo cubra entero: que no haya nada que pedirle
  // lo dice la propia tabla, y repetirlo acá sería un aviso que aparece siempre.
  const conStock = ctx();
  conStock.existencias = new Map([[3, 999999]]);
  const fuera = cargarFueraDelPlan(base(), conStock)([{ insumo_id: 1 }, { insumo_id: 2 }, { insumo_id: 3 }]);
  assert.equal(fuera.length, 0);
});

test('con el plan en borrador no hay nada afuera: la lista ES el cálculo de hoy', () => {
  const vivo = calcularPlan(ctx());
  const fuera = cargarFueraDelPlan(base(), ctx())(vivo.lineas, vivo);
  assert.equal(fuera.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// LAS OTRAS TRES PUERTAS
// ══════════════════════════════════════════════════════════════════════════

test('el insumo que no se compra deja de saltearse en silencio', () => {
  const insumos = new Map(INSUMOS);
  insumos.set(3, { ...INSUMOS.get(3), modo_provision: 'provee_cliente' });

  // El motor: no genera línea, lo anota, y NO bloquea el confirmar.
  const r = calcularPlan(ctx({ insumos }));
  assert.equal(r.lineas.find((x) => x.insumo_id === 3), undefined);
  assert.deepEqual(r.cobertura.insumos_no_se_compran,
    [{ insumo_id: 3, insumo: 'ESQUINERO 2 MTS', modo: 'provee_cliente' }]);
  assert.equal(r.cobertura.ok, true, 'que no se compre es una decisión, no un error');

  // Y se lee: el valor de la columna no es algo que se le pueda mostrar a nadie.
  assert.ok(r.advertencias.some((a) => a.includes('ESQUINERO 2 MTS') && a.includes('lo provee el cliente')),
    'la advertencia tiene que decir el modo en castellano: ' + JSON.stringify(r.advertencias));
  assert.ok(!r.advertencias.some((a) => a.includes('provee_cliente')),
    'y no el nombre de la columna');

  const fuera = cargarFueraDelPlan(base(), ctx({ insumos }))(CONGELADAS);
  assert.equal(fuera.length, 1);
  assert.equal(fuera[0].motivo, 'no_se_compra');
  assert.equal(fuera[0].detalle, 'lo provee el cliente');
});

test('el que no se compra se avisa UNA vez aunque esté en dos recetas', () => {
  const insumos = new Map(INSUMOS);
  insumos.set(3, { ...INSUMOS.get(3), modo_provision: 'comodato' });
  const productos = PRODUCTOS.concat([
    { id: 3, padre_id: 1, nombre: 'CAJA CHICA', unidad: 'caja', activo: 1, orden: 2,
      modo_reparto: 'particiona', share_pct: 0, receta_version: 1 }
  ]);
  productos[1] = { ...productos[1], share_pct: 60 };
  productos[2] = { ...productos[2], share_pct: 40 };
  const c = ctx({ insumos, productos });
  c.recetas.set(3, [{ producto_id: 3, insumo_id: 3, cantidad: 4, por_cada: 55, unidad: '1', merma_pct: 0, orden: 1 }]);

  const r = calcularPlan(c);
  assert.equal(r.cobertura.insumos_no_se_compran.length, 1);
  assert.equal(cargarFueraDelPlan(base(), c)(CONGELADAS).length, 1);
});

test('la unidad que dejó de coincidir dice cuál es cuál', () => {
  const insumos = new Map(INSUMOS);
  insumos.set(3, { ...INSUMOS.get(3), unidad_uso: 'UN' });   // la receta guardó «1»
  const fuera = cargarFueraDelPlan(base(), ctx({ insumos }))(CONGELADAS);
  assert.equal(fuera.length, 1);
  assert.equal(fuera[0].motivo, 'unidad');
  assert.match(fuera[0].detalle, /«1»/);
  assert.match(fuera[0].detalle, /«UN»/);
  assert.match(fuera[0].detalle, /CAJA GRANDE/, 'y de qué receta, que es donde hay que ir');
});

test('el insumo borrado sale con su nombre, que se busca en la base', () => {
  const db = base();
  db.exec("UPDATE pli_insumos SET eliminado_en='2026-10-20' WHERE id=3");
  const insumos = new Map(INSUMOS);
  insumos.delete(3);                       // el motor ya no lo encuentra
  const fuera = cargarFueraDelPlan(db, ctx({ insumos }))(CONGELADAS);
  assert.equal(fuera.length, 1);
  assert.equal(fuera[0].motivo, 'inexistente');
  assert.equal(fuera[0].insumo, 'ESQUINERO 2 MTS', '«insumo #3» no le dice nada a nadie');
  assert.match(fuera[0].detalle, /CAJA GRANDE/);
});

test('el insumo borrado se avisa UNA vez aunque lo usen dos recetas', () => {
  // `insumo_inexistente` trae una entrada POR NODO a propósito: le dice al que revisa
  // la cobertura en qué receta mirar. Acá la pregunta es otra —cuál falta—, y repetir
  // el mismo nombre tres veces convierte el aviso en una pared.
  const db = base();
  const insumos = new Map(INSUMOS);
  insumos.delete(3);
  const productos = PRODUCTOS.concat([
    { id: 3, padre_id: 1, nombre: 'CAJA CHICA', unidad: 'caja', activo: 1, orden: 2,
      modo_reparto: 'particiona', share_pct: 40, receta_version: 1 }
  ]);
  productos[1] = { ...productos[1], share_pct: 60 };
  const c = ctx({ insumos, productos });
  c.recetas.set(3, [{ producto_id: 3, insumo_id: 3, cantidad: 4, por_cada: 55, unidad: '1', merma_pct: 0, orden: 1 }]);
  assert.equal(calcularPlan(c).cobertura.insumo_inexistente.length, 2, 'el fixture tiene que dar dos');

  const fuera = cargarFueraDelPlan(db, c)(CONGELADAS);
  assert.equal(fuera.length, 1);
  assert.equal(fuera[0].insumo, 'ESQUINERO 2 MTS');
});

test('si no está ni en la base, igual se avisa con el número', () => {
  const db = base();
  db.exec('DELETE FROM pli_insumos WHERE id=3');
  const insumos = new Map(INSUMOS);
  insumos.delete(3);
  const fuera = cargarFueraDelPlan(db, ctx({ insumos }))(CONGELADAS);
  assert.equal(fuera.length, 1);
  assert.equal(fuera[0].insumo, 'insumo #3');
});

test('un aviso no puede dejar sin pantalla al que vino a comprar', () => {
  // Árbol circular: el motor tira a propósito. El aviso se calla y la lista se sigue viendo.
  const productos = [
    { id: 1, padre_id: 2, nombre: 'A', unidad: 'caja', activo: 1, orden: 1, modo_reparto: 'particiona', share_pct: 100, receta_version: 1 },
    { id: 2, padre_id: 1, nombre: 'B', unidad: 'caja', activo: 1, orden: 1, modo_reparto: 'particiona', share_pct: 100, receta_version: 1 }
  ];
  const c = ctx({ productos });
  assert.throws(() => calcularPlan(c), /circular/i, 'el fixture tiene que hacer tirar al motor');
  assert.deepEqual(cargarFueraDelPlan(base(), c)(CONGELADAS), []);
});

// ══════════════════════════════════════════════════════════════════════════
// EL CABLEADO: LAS DOS SALIDAS DE LA RUTA LO MANDAN
// ══════════════════════════════════════════════════════════════════════════

test('la ruta del cálculo manda fuera_del_plan en los dos caminos', () => {
  const f = fuente(RUTA, "router.get('/planes/:id/calculo'");
  // Confirmado: la lista es la congelada, así que el motor de hoy hay que correrlo.
  assert.match(f, /fuera_del_plan: fueraDelPlan\(soc, plan, r\.lineas\),/);
  // Borrador: el cálculo que ya corrió ES el de hoy. Correrlo de nuevo sería pagar dos veces.
  assert.match(f, /fuera_del_plan: fueraDelPlan\(soc, plan, r\.lineas, r\),/);
});

test('el plan confirmado sigue sin recalcularse: el aviso no descongela nada', () => {
  const f = fuente(RUTA, "router.get('/planes/:id/calculo'");
  assert.match(f, /if \(plan\.estado === 'confirmado' && req\.query\.simular !== '1'\) \{/);
  assert.match(f, /const r = resultadoMaterializado\(plan\);/);
});

// ══════════════════════════════════════════════════════════════════════════
// LA PANTALLA: EL HTML QUE VE EL OPERADOR
// ══════════════════════════════════════════════════════════════════════════

function panelHtml() {
  const src = fuente(PANEL, 'function pliEsc(s)') + '\n'
    + fuente(PANEL, 'function pliFueraDelPlanHtml(d)');
  return new Function(src + '\nreturn pliFueraDelPlanHtml;')();
}

test('sin nada afuera, no hay aviso: un cartel que aparece siempre no se lee', () => {
  const pinta = panelHtml();
  assert.equal(pinta({ origen: 'snapshot' }), '');
  assert.equal(pinta({ origen: 'snapshot', fuera_del_plan: [] }), '');
  assert.equal(pinta(null), '');
});

test('el aviso nombra al insumo y dice cómo hacerlo entrar', () => {
  const html = panelHtml()({
    origen: 'snapshot',
    fuera_del_plan: [{ insumo_id: 3, insumo: 'ESQUINERO 2 MTS', motivo: 'receta_nueva', detalle: null }]
  });
  assert.match(html, /Hay 1 insumo que la receta usa hoy y no está en este plan/);
  assert.match(html, /ESQUINERO 2 MTS/);
  assert.match(html, /entró a la receta después de confirmar el plan/);
  assert.match(html, /reabrí el plan y confirmalo de nuevo/i);
  assert.match(html, /Registrar compra/);
});

test('el plural se escribe, no se arma con (s)', () => {
  const html = panelHtml()({
    origen: 'snapshot',
    fuera_del_plan: [
      { insumo_id: 3, insumo: 'ESQUINERO 2 MTS', motivo: 'receta_nueva' },
      { insumo_id: 4, insumo: 'FAJA', motivo: 'no_se_compra', detalle: 'está en comodato' }
    ]
  });
  assert.match(html, /Hay 2 insumos que la receta usa hoy y no están en este plan/);
  assert.match(html, /FAJA<\/b> — no se compra: está en comodato/);
});

test('sin ningún insumo nuevo no se manda a reabrir el plan: no haría nada', () => {
  const html = panelHtml()({
    origen: 'snapshot',
    fuera_del_plan: [{ insumo_id: 4, insumo: 'FAJA', motivo: 'no_se_compra', detalle: 'está en comodato' }]
  });
  assert.ok(!/reabrí el plan/i.test(html), 'reabrir no arregla un insumo que no se compra');
});

test('en un borrador el motivo no habla de confirmar, porque todavía no se confirmó', () => {
  const html = panelHtml()({
    origen: 'calculo',
    fuera_del_plan: [{ insumo_id: 3, insumo: 'ESQUINERO 2 MTS', motivo: 'receta_nueva' }]
  });
  assert.ok(!/después de confirmar/.test(html));
  assert.ok(!/reabrí el plan/i.test(html));
});

test('el nombre del insumo se escapa: viene de lo que alguien tipeó', () => {
  const html = panelHtml()({
    origen: 'snapshot',
    fuera_del_plan: [{ insumo_id: 9, insumo: '<img src=x onerror=alert(1)>', motivo: 'receta_nueva' }]
  });
  assert.ok(!html.includes('<img'), 'se coló el tag: ' + html);
  assert.match(html, /&lt;img/);
});

test('un motivo que la pantalla no conozca se muestra igual', () => {
  // Si mañana el backend agrega uno, es mejor un texto feo que un renglón en blanco.
  const html = panelHtml()({ origen: 'snapshot', fuera_del_plan: [{ insumo_id: 1, insumo: 'X', motivo: 'algo_nuevo' }] });
  assert.match(html, /algo_nuevo/);
});

test('las cuatro vistas de Comprar lo muestran, porque cuelga del aviso común', () => {
  // pliCmpAvisoBuckets() es lo que las cuatro vistas anteponen. Se ejecuta de verdad.
  const src = fuente(PANEL, 'function pliEsc(s)') + '\n'
    + fuente(PANEL, 'function pliFueraDelPlanHtml(d)') + '\n'
    + fuente(PANEL, 'function pliCmpAvisoBuckets()') + '\n'
    + fuente(PANEL, 'function pliCmpAvisoSnapshot()');
  const f = new Function('PLI', src + '\nreturn pliCmpAvisoBuckets;')({
    cmpCalculo: { origen: 'snapshot', fuera_del_plan: [{ insumo_id: 3, insumo: 'ESQUINERO 2 MTS', motivo: 'receta_nueva' }] }
  });
  assert.match(f(), /ESQUINERO 2 MTS/);

  for (const v of ['pliCmpRenderPorInsumo', 'pliCmpRenderAgenda', 'pliCmpRenderSemanas', 'pliCmpRenderHechas']) {
    assert.match(fuente(PANEL, 'function ' + v + '('), /pliCmpAvisoBuckets\(\)/,
      v + ' tiene que anteponer el aviso común');
  }
});

test('la solapa Planes lo muestra también: es donde está el botón de reabrir', () => {
  const f = fuente(PANEL, 'function pliResultadoRender()');
  assert.match(f, /html \+= pliFueraDelPlanHtml\(d\);/);
});

// ══════════════════════════════════════════════════════════════════════════
// EL MANUAL, CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════

const MANUAL = fuente(PANEL, 'SG_MANUAL.pli = ');

test('el manual estrena la entrada con su versión', () => {
  assert.match(MANUAL, /Confirmar el plan lo congela/);
  assert.match(MANUAL, /sgManCampo\('Insumos que la receta usa y el plan no tiene'/);
  assert.match(MANUAL, /'V1105'\)/);
});

test('lo que el manual manda hacer —reabrir y confirmar— es lo que descongela el plan', () => {
  assert.match(MANUAL, /reabrir el plan y confirmarlo de nuevo/);
  const reabrir = fuente(RUTA, "router.post('/planes/:id/reabrir'");
  assert.match(reabrir, /DELETE FROM pli_plan_resultado WHERE plan_id=\?/);
  assert.match(reabrir, /receta_snapshot_json=NULL/);
  assert.match(reabrir, /estado='borrador'/);
  const confirmar = fuente(RUTA, "router.post('/planes/:id/confirmar'");
  assert.match(confirmar, /const r = calcularPlan\(ctx\);/, 'confirmar vuelve a correr el motor');
});

test('lo que el manual dice de + Registrar compra es cierto: tiene TODOS los insumos', () => {
  assert.match(MANUAL, /Registrar compra/);
  const f = fuente(PANEL, 'function pliCompraOpcionesInsumo(sel)');
  assert.match(f, /PLI\.insumos\.filter/, 'sale del padrón completo');
  assert.ok(!/cmpCalculo|lineas|fuera_del_plan/.test(f), 'y no de las líneas del plan');
});

test('los cuatro motivos del manual son los cuatro que emite el backend', () => {
  const f = fuente(RUTA, 'function fueraDelPlan(soc, plan, lineas, vivo)');
  const emitidos = [...f.matchAll(/'(receta_nueva|no_se_compra|unidad|inexistente)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(emitidos)].sort(),
    ['inexistente', 'no_se_compra', 'receta_nueva', 'unidad']);
  // Y la pantalla sabe leer los cuatro.
  const p = fuente(PANEL, 'function pliFueraDelPlanHtml(d)');
  for (const m of ['receta_nueva', 'no_se_compra', 'unidad', 'inexistente']) {
    assert.match(p, new RegExp(m + ':'), 'la pantalla no sabe traducir ' + m);
  }
});

test('los tres modos de provisión que no son compra tienen su texto', () => {
  const check = DDL.match(/CHECK\(modo_provision IN \(([^)]+)\)\)/);
  assert.ok(check, 'no encontré el CHECK de modo_provision');
  const modos = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((m) => m !== 'compra');
  assert.ok(modos.length >= 3, modos.join(','));
  for (const m of modos) {
    assert.ok(MODO_TEXTO[m], 'falta cómo se lee «' + m + '»: saldría el nombre de la columna');
  }
});

test('el manual dice por qué está congelado, no sólo que lo está', () => {
  assert.match(MANUAL, /editar una receta después/);
  assert.match(MANUAL, /solo porque alguien tocó una receta/);
});
