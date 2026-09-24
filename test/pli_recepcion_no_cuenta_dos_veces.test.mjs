// ══ LO RECIBIDO NO PUEDE CONTAR DOS VECES ══════════════════════════════════
//
// La V1082 hizo que confirmar la recepción le sumara la mercadería al stock del insumo. Lo que no
// vio es que el plan arma la cobertura sumando DOS cosas contra la misma necesidad: lo que hay en el
// depósito y lo que está comprado. La compra seguía contando entera, así que la misma mercadería
// contaba dos veces y el plan decía «a comprar 0» cuando faltaba la mitad.
//
// Este archivo corre el MOTOR DE VERDAD —`calcularPlan` es una función pura, sin imports— con la
// consulta real que arma `comprado`, leída de rutas/planificacion.js. No mira el texto del código:
// mira el número que le sale al plan.
//
// Y clava las otras tres puertas por las que el stock se descuadraba: marcar «recibido» a mano sin
// que entre nada, bajar la cantidad por debajo de lo que ya entró, y recibir más de lo pedido.
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
const { calcularPlan } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/pli_motor.js')));

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

const TABLAS = ['pli_insumos', 'pli_compras'];
function base() {
  const db = new DatabaseSync(':memory:');
  for (const t of TABLAS) {
    const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    assert.ok(i >= 0, 'no está la tabla ' + t);
    db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  for (const m of DDL.match(/addCol\('[a-z_]+',\s*'[a-z_]+',\s*'[^']+'\)/g) || []) {
    const [, t, col, tipo] = /addCol\('([a-z_]+)',\s*'([a-z_]+)',\s*'([^']+)'\)/.exec(m);
    if (!TABLAS.includes(t)) continue;
    if (!db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).includes(col)) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${tipo}`);
    }
  }
  // ETIQUETA, que se compra por millar y se consume por unidad: es donde el factor amplifica
  // cualquier error, y es un insumo real del módulo.
  db.exec(`INSERT INTO pli_insumos (id, sociedad_id, nombre, unidad_compra, unidad_uso,
             factor_compra, stock_inicial, lead_time_dias, modo_provision)
           VALUES (1, 1, 'ETIQUETA DAMASCO', 'MILLAR', 'unidad', 1000, 0, 15, 'compra')`);
  return db;
}

// LA CONSULTA REAL que arma `comprado`, sacada del router: si mañana cambia, este banco de pruebas
// mide la nueva y no una copia que quedó vieja.
function compradoSql() {
  const f = fuente(RUTA, 'function armarContexto(soc, plan)');
  const m = /SELECT insumo_id, SUM\([\s\S]*?GROUP BY insumo_id/.exec(f);
  assert.ok(m, 'no encontré la consulta de lo comprado');
  return m[0];
}

// Corre el motor con un objetivo que necesita `necesidadUso` unidades del insumo 1.
function plan(db, necesidadUso) {
  const comprado = new Map(db.prepare(compradoSql()).all(5).map((c) => [c.insumo_id, c.total]));
  const existencias = new Map(
    db.prepare('SELECT id, stock_inicial FROM pli_insumos').all().map((i) => [i.id, i.stock_inicial])
  );
  const r = calcularPlan({
    plan: { id: 5 },
    productos: [{ id: 1, padre_id: null, nombre: 'DAMASCO', unidad: 'kg', activo: 1, receta_version: 1 }],
    objetivos: [{ producto_id: 1, cantidad: necesidadUso, unidad: 'kg', bucket_ini: '2026-11-02' }],
    recetas: new Map([[1, [{ producto_id: 1, insumo_id: 1, cantidad: 1, por_cada: 1,
      unidad: 'unidad', merma_pct: 0, version: 1, orden: 1 }]]]),
    insumos: new Map([[1, db.prepare('SELECT * FROM pli_insumos WHERE id=1').get()]]),
    existencias,
    comprado,
  });
  const l = r.lineas.find((x) => x.insumo_id === 1);
  return { comprar: l ? l.bultos_a_comprar : 0, enViaje: l ? l.ya_comprado_bultos : 0, cobertura: r.cobertura };
}

const compra = (db, extra) => {
  const c = Object.assign({ id: 1, cantidad: 100, estado: 'pedido', recibido: null }, extra);
  db.prepare(`INSERT INTO pli_compras (id, plan_id, insumo_id, fecha, cantidad, estado, recibido_cantidad)
              VALUES (?,5,1,'2026-09-02',?,?,?)`).run(c.id, c.cantidad, c.estado, c.recibido);
};

// ── EL NÚMERO DEL PLAN ─────────────────────────────────────────────────────

test('recibir TODO lo pedido no borra de la lista lo que todavía falta comprar', () => {
  const db = base();
  // Hacen falta 200 millares y hay una compra de 100.
  compra(db, { cantidad: 100 });
  assert.equal(plan(db, 200000).comprar, 100, 'con la compra pedida, faltan 100');
  // Llegan los 100: entran al depósito (en unidad de USO, por el factor) y la compra deja de estar
  // en viaje. Lo que falta comprar NO CAMBIA: la mercadería es la misma.
  db.prepare('UPDATE pli_compras SET estado=?, recibido_cantidad=? WHERE id=1').run('recibido', 100);
  db.prepare('UPDATE pli_insumos SET stock_inicial=? WHERE id=1').run(100 * 1000);
  const p = plan(db, 200000);
  assert.equal(p.comprar, 100, 'recibir la compra hizo desaparecer de la lista lo que falta comprar');
  assert.equal(p.enViaje, 0, 'una compra que ya llegó sigue contando como en viaje');
});

test('la entrega corta —la que Pablo pidió poder cargar— deja en viaje sólo lo que falta llegar', () => {
  const db = base();
  compra(db, { cantidad: 100 });
  // Llegaron 60 de los 100: 60 al depósito, 40 siguen en viaje.
  db.prepare('UPDATE pli_compras SET estado=?, recibido_cantidad=? WHERE id=1').run('recibido', 60);
  db.prepare('UPDATE pli_insumos SET stock_inicial=? WHERE id=1').run(60 * 1000);
  const p = plan(db, 200000);
  assert.equal(p.enViaje, 40, 'lo que falta llegar no son 40');
  assert.equal(p.comprar, 100, 'la cuenta de lo que falta comprar cambió al recibir de menos');
});

test('una compra marcada «recibido» a mano, que no movió stock, sigue contando entera', () => {
  // Es el dato que ya existe: antes de la recepción, «recibido» era sólo una etiqueta. Esas compras
  // no sumaron nada al depósito, así que lo que está en viaje es todo. Si se las dejara afuera, el
  // plan mandaría a comprar de nuevo algo que ya está pedido.
  const db = base();
  compra(db, { cantidad: 100, estado: 'recibido', recibido: null });
  assert.equal(plan(db, 200000).enViaje, 100);
});

test('las canceladas no cuentan, ni antes ni después de la recepción', () => {
  const db = base();
  compra(db, { cantidad: 100, estado: 'cancelado' });
  assert.equal(plan(db, 200000).comprar, 200);
  assert.equal(plan(db, 200000).enViaje, 0);
});

test('un dato viejo con más recibido que pedido no RESTA cobertura', () => {
  // `cantidad − recibido` en negativo le sacaría cobertura al plan y lo mandaría a comprar de más.
  const db = base();
  compra(db, { cantidad: 100, estado: 'recibido', recibido: 120 });
  db.prepare('UPDATE pli_insumos SET stock_inicial=? WHERE id=1').run(120 * 1000);
  const p = plan(db, 200000);
  assert.equal(p.enViaje, 0);
  assert.equal(p.comprar, 80, 'el renglón restó cobertura en vez de no aportar nada');
});

test('la misma cuenta en el plan en borrador y en el confirmado que se recalcula', () => {
  // Son dos consultas distintas en el router, una por cada camino. Arreglar una sola hace que el
  // número CAMBIE al confirmar el plan, que es peor que estar mal en los dos lados.
  const borrador = compradoSql().replace(/\s+/g, ' ');
  const snap = /SELECT insumo_id, SUM\([\s\S]*?GROUP BY insumo_id/
    .exec(fuente(RUTA, 'function bucketsDesdeSnapshot(plan)'))[0].replace(/\s+/g, ' ');
  assert.equal(snap, borrador, 'las dos consultas de lo comprado dejaron de ser iguales');
  assert.match(borrador, /cantidad - COALESCE\(recibido_cantidad, 0\)/);
  assert.match(borrador, /MAX\(0,/);
});

// ── UNA SOLA PUERTA A «RECIBIDO» ───────────────────────────────────────────

test('el alta no puede nacer «recibida»: a ese estado se llega recibiendo', () => {
  const alta = fuente(RUTA, "router.post('/planes/:id/compras'");
  assert.match(alta, /if \(estado === 'recibido'\) \{/);
  assert.match(alta, /botón 📦/);
  // Y la corrección tampoco, mientras no haya recepción confirmada.
  const patch = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  assert.match(patch, /if \(estado === 'recibido' && !recibida\) \{/);
  // Pero una compra que SÍ se recibió se sigue pudiendo guardar con su estado: el formulario lo
  // manda siempre, y si rebotara no se podría corregir ni el proveedor.
  assert.ok(/estado === 'recibido' && !recibida/.test(patch),
    'el cerrojo frena también a las que sí tienen recepción');
});

test('el selector de la pantalla no ofrece «Recibido», y una recibida no se vuelve «pedido» al guardar', () => {
  // La opción se saca del HTML: la que no existe no se puede elegir.
  const sel = PANEL.slice(PANEL.indexOf('<select id="pli-cmp-estado"'));
  const cierre = sel.slice(0, sel.indexOf('</select>'));
  assert.ok(!/value="recibido"/.test(cierre), 'el selector sigue ofreciendo «Recibido»');
  assert.match(cierre, /value="pedido"/);
  assert.match(cierre, /value="cancelado"/);
  // Y PARA UNA COMPRA YA RECIBIDA SE AGREGA AL VUELO. Sin esto, el selector caería en «Pedido» y
  // guardar cualquier corrección le devolvería el stock sin que nadie lo pida.
  const f = fuente(PANEL, 'function pliCompraEstadoOpciones(c)');
  assert.match(f, /if \(c && c\.recibido_cantidad != null\)/);
  assert.match(f, /o\.value = 'recibido';/);
  assert.match(f, /sel\.value = c \? c\.estado : 'pedido';/);
  // Y el abridor la usa, en vez de escribir el valor a mano.
  assert.match(fuente(PANEL, 'function pliCompraAbrir'), /pliCompraEstadoOpciones\(c\)/);
});

// ── LOS DOS TOPES ──────────────────────────────────────────────────────────

test('no se puede bajar la cantidad por debajo de lo que ya entró al depósito', () => {
  const patch = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  assert.match(patch, /recibida && b\.cantidad !== undefined/);
  assert.match(patch, /< Number\(a\.recibido_cantidad\)/);
  // El mensaje dice el número: «no se puede» sin el dato no le sirve a nadie.
  assert.match(patch, /ya entraron ' \+ a\.recibido_cantidad \+ ' al depósito/);
  // Y frena ANTES de escribir.
  assert.ok(patch.indexOf('ya entraron') < patch.indexOf('UPDATE pli_compras SET fecha=?'),
    'la cantidad se escribe antes de verificarla');
});

test('no se recibe más de lo que se pidió: es el tipeo que infla el stock mil veces', () => {
  const rec = fuente(RUTA, "router.post('/planes/:id/compras/:compraId/recepcion'");
  assert.match(rec, /if \(cantidad > Number\(c\.cantidad\)\) \{/);
  assert.match(rec, /Se pidieron ' \+ c\.cantidad \+ ' y estás recibiendo/);
  // Y frena ANTES de tocar el stock, no después.
  assert.ok(rec.indexOf('estás recibiendo') < rec.indexOf('moverStockPorRecepcion'),
    'el stock se mueve antes de verificar la cantidad');
});

// ── EL PISOTÓN DE LA FICHA DEL INSUMO ──────────────────────────────────────

test('guardar la ficha del insumo no le borra al depósito una recepción de hace cinco minutos', () => {
  // La casilla del stock se llena cuando se abre la ficha y antes viajaba en TODO guardado. Con
  // eso, una recepción confirmada entre que se abrió y se guardó desaparecía del depósito —y la
  // compra seguía diciendo que la había aplicado, así que deshacerla restaba lo que ya no estaba—.
  const g = fuente(PANEL, 'function pliInsGuardar()');
  assert.ok(!/^\s+stock_inicial: document/m.test(g), 'el stock sigue viajando en cada guardado');
  assert.match(g, /if \(!id \|\| String\(stock\) !== String\(PLI\.stockAlAbrir\)\) body\.stock_inicial = stock;/);
  // Y el abridor guarda con qué valor se abrió, que es contra lo que se compara.
  assert.match(PANEL, /PLI\.stockAlAbrir = document\.getElementById\('pli-ins-stock'\)\.value;/);
  // El insumo NUEVO sí lo manda: ahí el stock inicial es un dato del alta y no hay nada que pisar.
  assert.match(g, /!id \|\|/);
});

// ── LO QUE LA PANTALLA CUENTA ──────────────────────────────────────────────

test('la pantalla ya no dice que lo pedido cuenta «porque está comprometido»', () => {
  const f = fuente(PANEL, 'function pliCmpRenderHechas(cont)');
  assert.ok(!/Las pedidas sí, porque ya están comprometidas/.test(f),
    'la leyenda sigue diciendo lo que dejó de ser cierto');
  assert.match(f, /ya llegó<\/b> cubre por el/);
  assert.match(f, /todavía no llegó<\/b> cuenta como en viaje/);
  // Y el detalle del sobrante llama a las cosas por su nombre: «comprado» ahí eran las dos cosas
  // juntas, y ahora es sólo lo que falta llegar.
  assert.match(fuente(PANEL, 'function pliSobranteDetalle(l)'), /\+ ' \+ en viaje '/);
  // Y la columna del cuadro tampoco se llama «Ya comprado»: ese nombre ahora es la mitad del
  // número. Lo que ya llegó se ve en el stock del insumo.
  assert.ok(!/>Ya comprado</.test(PANEL), 'quedó una columna llamada «Ya comprado»');
  assert.match(PANEL, />En viaje</);
});

test('una compra de la que llegó la mitad no dice «recibido» a secas', () => {
  const f = fuente(PANEL, 'function pliCmpRenderHechas(cont)');
  assert.match(f, /recibido en parte/);
  // Y la que quedó marcada recibida sin pasar por la recepción se distingue: es la que hay que
  // recibir de verdad, y es la única que no sumó nada al depósito.
  assert.match(f, /recibido · sin confirmar/);
  assert.match(f, /var sinRecibir = c\.estado === 'recibido' && c\.recibido_cantidad == null;/);
  assert.match(f, /pliEsc\(etiqueta\)/);
});

test('la ventana de recepción dice que el número es el TOTAL, y suma la entrega nueva por su cuenta', () => {
  // El campo es el total aplicado —es lo que hace que confirmar dos veces no duplique— pero el que
  // ya recibió 60 y hoy recibe 40 lee «cuánto llegó», escribe 40, y el servidor le RESTA 20.
  const f = fuente(PANEL, 'function pliRecepAbrir(id)');
  assert.match(f, /textContent = ya \? 'Total recibido \*' : 'Cuánto llegó \*';/);
  const s = fuente(PANEL, 'function pliRecepSumar()');
  assert.match(s, /Number\(c\.recibido_cantidad\) \+ n/);
  assert.match(s, /¿Cuánto llegó AHORA/);
  // El botón sólo aparece cuando ya hay algo recibido: en la primera recepción no hay qué sumar.
  assert.match(f, /getElementById\('pli-rec-sumar'\)\.style\.display = ya \? '' : 'none';/);
});
