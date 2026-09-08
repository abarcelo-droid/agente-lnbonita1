// ══ LA FACTURA ES DEL FLETERO, NO DEL PROVEEDOR DE LA MERCADERÍA ══════════
//
// Pablo, 8/9/2026: «no me trae las partidas valorizadas para poder ingresarlas
// como facturas».
//
// LA CAUSA. La lista de Fletes de entrada muestra en la columna «Proveedor» al
// proveedor de la MERCADERÍA; la factura del viaje la emite el FLETERO, que es
// otro y NO se mostraba en ningún lado. Así que en «¿De quién es la factura?» se
// elegía el nombre que se veía en la lista —el equivocado— y la pantalla
// contestaba «no hay fletes valorizados sin facturar de este fletero»: la MISMA
// respuesta que si de verdad no hubiera nada. No había forma de distinguir haber
// elegido mal de no tener nada pendiente.
//
// Y de paso, lo que pidió en el mismo rato: que el proveedor se busque
// ESCRIBIENDO y por CONTIENE, como los rubros contables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL BUSCADOR, CORRIDO DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// No alcanza con ver que el código diga «indexOf»: lo que importa es que
// escribiendo un pedazo del medio aparezca el proveedor, y que el que tiene algo
// pendiente salga primero. Se monta la función con el mundo simulado.
function buscador(provs, pend) {
  const src = trozo(PANEL, 'function sgFgProvBuscar(){', '\r\n}');
  const caja = { innerHTML: '', style: { display: 'none' } };
  const input = { value: '' };
  const mundo = {
    SGFG: { provs, pend },
    eid: (id) => (id === 'sg-fg-provlist' ? caja : (id === 'sg-fg-provq' ? input : null)),
    // El mismo normalizador del panel: saca acentos y pasa a minúscula.
    sgNorm: (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    escH: (v) => String(v == null ? '' : v),
    sgMoney: (v) => '$' + Number(v || 0),
  };
  const f = new Function(...Object.keys(mundo), src + '\nreturn sgFgProvBuscar;')(
    ...Object.values(mundo));
  return { correr: (q) => { input.value = q; f(); return caja.innerHTML; }, caja };
}

const PROVS = [
  { id: 7, nombre: 'AGROINSUMOS ARDISONE S.R.L.' },
  { id: 9, nombre: 'AGRICOLA ABRAXAS SRL' },
  { id: 4, nombre: 'PUENTE CORDÓN SA' },
  { id: 5, nombre: 'ZZZ TRANSPORTES' },
];

test('busca POR CONTIENE, no sólo por cómo empieza', () => {
  // El desplegable obligaba a bajar el padrón a ojo. Y un buscador que sólo
  // mirara el principio no sirve: nadie se acuerda si es «AGROINSUMOS ARDISONE»
  // o «ARDISONE AGROINSUMOS».
  const b = buscador(PROVS, {});
  const h = b.correr('ardisone');
  assert.match(h, /AGROINSUMOS ARDISONE/);
  assert.ok(!/ABRAXAS/.test(h), 'trajo uno que no contiene lo escrito');
});

test('y sin acentos: «cordon» encuentra «CORDÓN»', () => {
  const b = buscador(PROVS, {});
  assert.match(b.correr('cordon'), /PUENTE CORD/);
});

test('cada uno dice cuánto tiene SIN FACTURAR', () => {
  // Es lo que faltaba: elegir el que no era contestaba lo mismo que si de verdad
  // no hubiera nada, y no había cómo distinguir una cosa de la otra.
  const b = buscador(PROVS, { 7: { id: 7, pendientes: 3, total: 660000 } });
  const h = b.correr('agro');
  assert.match(h, /3 sin facturar/);
  assert.match(h, /\$660000/);
});

test('el que no tiene nada lo dice, y se puede elegir igual', () => {
  // No se esconde: hay que poder entrar a un proveedor sin nada pendiente para
  // ANULAR una factura que ya se le cargó (ésa es la lista de abajo del modal).
  const b = buscador(PROVS, {});
  const h = b.correr('abraxas');
  assert.match(h, /nada pendiente/);
  assert.match(h, /onmousedown="sgFgProvPick\(9\)"/);
});

test('los que tienen algo pendiente van PRIMERO', () => {
  // Es la pregunta que se está haciendo: a quién le estoy por cargar una factura.
  const b = buscador(PROVS, { 5: { id: 5, pendientes: 1, total: 100 } });
  const h = b.correr('');
  assert.ok(h.indexOf('ZZZ TRANSPORTES') < h.indexOf('AGRICOLA ABRAXAS'),
    'el que tiene pendientes tiene que salir arriba, aunque alfabéticamente vaya último');
});

test('y el resto queda ordenado por nombre', () => {
  const b = buscador(PROVS, {});
  const h = b.correr('');
  assert.ok(h.indexOf('AGRICOLA ABRAXAS') < h.indexOf('AGROINSUMOS ARDISONE'));
  assert.ok(h.indexOf('AGROINSUMOS ARDISONE') < h.indexOf('PUENTE CORD'));
});

test('sin resultados lo dice, no queda una lista vacía', () => {
  const b = buscador(PROVS, {});
  assert.match(b.correr('no existe nadie asi'), /Sin resultados/);
});

test('el campo es un buscador, no un desplegable, y sigue habiendo dónde leer el id', () => {
  const html = trozo(PANEL, '<label>¿De quién es la factura?', '</div></div>');
  assert.match(html, /id="sg-fg-provq"/);
  assert.match(html, /oninput="sgFgProvBuscar\(\)"/);
  // El id elegido sigue viviendo en sg-fg-prov: lo leen guardar, la lista de ya
  // facturadas y la lectura del PDF. Si desapareciera, todo eso lee undefined.
  assert.match(html, /<input type="hidden" id="sg-fg-prov">/);
  assert.ok(!/<select id="sg-fg-prov"/.test(PANEL), 'quedó el desplegable viejo');
});

test('elegir uno completa el campo y dispara la búsqueda de operaciones', () => {
  const f = trozo(PANEL, 'function sgFgProvPick(id){', '\r\n}');
  assert.match(f, /hid\.value = p\.id/);
  assert.match(f, /inp\.value = p\.nombre/);
  // Sin esto el nombre queda escrito y la tabla de abajo vacía.
  assert.match(f, /sgFgProv\(\);/);
});

test('dos cooperativas del mismo proveedor son UNO en la lista', () => {
  const f = trozo(PANEL, 'function sgFgProvs(){', '\r\n}');
  assert.match(f, /vistos\[String\(x\.proveedor_id\)\]/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL RESUMEN USA EL MISMO CRITERIO QUE LA TABLA
// ══════════════════════════════════════════════════════════════════════════

test('el resumen cuenta lo mismo que después se ofrece', () => {
  // Si fuera otro criterio, el selector diría «3 sin facturar» y al elegirlo no
  // aparecería ninguna: peor que no decir nada.
  const r = trozo(SG, "router.get('/gastos-facturables/resumen'", '\r\n});');
  for (const cond of [
    /g\.estado = 'valorizado'/,
    /g\.activo = 1/,
    /g\.tipo_gasto IN \(\$\{c\.tipos\.map\(\(\) => '\?'\)\.join\(','\)\}\)/,
    /NOT EXISTS \(SELECT 1 FROM sg_factura_gasto_items fi/,
    /JOIN sg_facturas_gasto f ON f\.id = fi\.factura_id AND f\.activo = 1/,
  ]) assert.match(r, cond);
  assert.match(r, /GROUP BY g\.proveedor_servicio_id/);
});

test('el resumen es por circuito: el fletero que además cobra descargas no las mezcla', () => {
  const r = trozo(SG, "router.get('/gastos-facturables/resumen'", '\r\n});');
  assert.match(r, /const c = circuitoFactura\(req\.query\.circuito\)/);
  assert.match(r, /Ese circuito no existe/);
});

test('y no cuenta los gastos sin fletero cargado', () => {
  // Un gasto con proveedor_servicio_id NULL agruparía en una fila fantasma que
  // no corresponde a ningún proveedor del padrón.
  const r = trozo(SG, "router.get('/gastos-facturables/resumen'", '\r\n});');
  assert.match(r, /g\.proveedor_servicio_id IS NOT NULL/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL FLETERO SE VE EN LA LISTA
// ══════════════════════════════════════════════════════════════════════════

test('la fila de Fletes de entrada muestra al fletero, no sólo al de la mercadería', () => {
  const f = trozo(PANEL, 'function sgFePintar(){', '\r\nfunction ');
  assert.match(f, /x\.fletero_nombre/);
  assert.match(f, />flete: ' \+ escH\(x\.fletero_nombre\)/);
  // Y el backend lo trae: sin la columna, el front lee undefined y no muestra nada.
  const q = trozo(SG, "router.get('/fletes-entrada'", '\r\n});');
  assert.match(q, /pv\.razon_social AS fletero_nombre/);
});

test('y se puede buscar por él', () => {
  const f = trozo(PANEL, 'function sgFePintar(){', '\r\nfunction ');
  // Lo que se busca es el TEXTO del filtro, sin atarse a que el fletero sea lo
  // último: después se le sumó la marca de «iva adentro» y esto daba rojo sin
  // que se hubiera roto nada.
  const filtro = trozo(f, 'var filas = SGFE.filas.filter(', '});');
  assert.match(filtro, /\(x\.fletero_nombre \|\| ''\)/);
  assert.match(filtro, /\.indexOf\(q\) >= 0/);
  assert.match(PANEL, /placeholder="🔎 Partida, proveedor o fletero…"/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL ASIENTO MODELO DE VENTA SALIÓ DE LA VENTANA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 8/9/2026: «la configuración del asiento modelo quedó dentro de la
// ventana y la idea es dejarlo fuera: repliquemos el modelo de gastos directos».

test('la ventana de facturar ya no lleva la parametrización adentro', () => {
  assert.ok(!/id="sgfd-modelo-box"/.test(PANEL), 'el bloque sigue dentro de la ventana');
  assert.ok(!/id="sgfd-modelo-cuerpo"/.test(PANEL));
  // Y las tres funciones que hacían aparte lo que ya hace el bloque genérico.
  for (const f of ['sgFdModeloCargar', 'sgFdModeloDetalle', 'sgFdModeloGuardar', 'SGFD_MODELO']) {
    assert.ok(!PANEL.includes(f), 'quedó ' + f);
  }
});

test('está en la puerta, como en Gastos Directos', () => {
  const card = trozo(PANEL, '<div style="font-weight:700;font-size:14px;margin-bottom:4px">💵 Facturar en el puesto</div>', '</div>\r\n    </div>');
  assert.match(card, /id="sgfd-modelo-btn"[\s\S]{0,120}onclick="sgModeloAbrir\('venta'\)"/);
  // Y el aviso de cuando falta, que es lo único accionable para el que factura.
  assert.match(card, /id="sgfd-modelo-falta"/);
});

test('venta es un circuito más del bloque genérico', () => {
  const t = trozo(PANEL, 'var SG_MODELOS = {', '\r\n};');
  assert.match(t, /venta: \{/);
  assert.match(t, /ruta: '\/api\/sg\/ventas\/modelo-venta'/);
  assert.match(t, /btn: 'sgfd-modelo-btn', av: 'sgfd-modelo-falta'/);
});

test('el aviso se ve al ENTRAR a la solapa, sin abrir la ventana', () => {
  // Si saliera de abrir la ventana, habría que abrirla para enterarse de que las
  // ventas no están asentando — justo lo que no puede pasar.
  const f = trozo(PANEL, 'function sgVenSub(s){', '\r\n}');
  assert.match(f, /s==='directa'\) sgModeloCargar\('venta'\)/);
});

test('y el botón se esconde al que no es admin, como los otros cuatro', () => {
  const f = trozo(PANEL, 'function sgAsientoModeloVisible(){', '\r\n}');
  assert.match(f, /'sgfd-modelo-btn'/);
  assert.ok(!f.includes("'sgfd-modelo-box'"), 'sigue escondiendo un id que ya no existe');
});

test('la lista de modelos viaja con el de venta', () => {
  // El bloque genérico arma el selector con data.modelos. Sin esto la pantalla
  // tendría que pedir /contable/modelos aparte, que es lo que hacía la copia.
  const r = trozo(VEN, "router.get('/modelo-venta'", '\r\n});');
  assert.match(r, /SELECT id, nombre FROM sg_asientos_modelo WHERE activo=1 ORDER BY nombre/);
  // En las TRES salidas: sin modelo elegido, con el modelo perdido y con modelo.
  assert.equal((r.match(/modelos/g) || []).length >= 4, true);
});

test('sgFgAbrir no abre la ventana de factura con el circuito de venta', () => {
  // 'venta' está en SG_MODELOS para configurarse, pero no se le ingresa una
  // factura a nadie: se EMITE. Sin el guardián, el título y las columnas quedaban
  // en undefined.
  const f = trozo(PANEL, 'function sgFgAbrir(circuito){', '\r\n}');
  assert.match(f, /SG_MODELOS\[circuito\] && SG_MODELOS\[circuito\]\.facturaTit/);
});

test('guardar el modelo rehace el cuadro de la venta que se está cargando', () => {
  // El cuadro de abajo se armó con el modelo VIEJO: si no se rehace, se aprueba
  // un asiento que no es el que se va a grabar.
  const f = trozo(PANEL, 'function sgModeloGuardar(k){', '\r\n}');
  assert.match(f, /k === 'venta'[\s\S]{0,160}sgFdRender\(\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL MANUAL VA CON EL CAMBIO
// ══════════════════════════════════════════════════════════════════════════

test('el «¿cómo se usa?» explica las tres cosas, con su versión', () => {
  assert.match(PANEL, /La factura es del FLETERO, no del proveedor de la mercadería[\s\S]{0,80}V1022/);
  assert.match(PANEL, /El proveedor se escribe, y dice cuánto tiene sin facturar[\s\S]{0,80}V1022/);
  assert.match(PANEL, /El de VENTAS también tiene su puerta[\s\S]{0,80}V1022/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · DOS ASPEREZAS DEL BUSCADOR
// ══════════════════════════════════════════════════════════════════════════

// Monta sgFgProvBlur con el mundo simulado: lo que importa es qué queda en el
// campo, no cómo está escrito.
function salir(provs, hid0, txt0) {
  const src = trozo(PANEL, 'function sgFgProvCerrar(){', '\r\n}')
    + trozo(PANEL, 'function sgFgProvBlur(){', '\r\n}');
  const caja = { style: { display: '' } };
  const hid = { value: hid0 }, inp = { value: txt0 };
  let recargas = 0;
  const mundo = {
    SGFG: { provs },
    eid: (id) => ({ 'sg-fg-provlist': caja, 'sg-fg-prov': hid, 'sg-fg-provq': inp }[id] || null),
    sgFgProv: () => { recargas++; },
  };
  new Function(...Object.keys(mundo), src + '\nreturn sgFgProvBlur;')(
    ...Object.values(mundo))();
  return { hid: hid.value, txt: inp.value, recargas };
}

test('escribir el nombre entero NO es haberlo elegido', () => {
  // Si no, el campo muestra «AGROINSUMOS ARDISONE» y por dentro no hay nadie: al
  // guardar contesta «elegí a quién le entra la factura» con el nombre ahí
  // adelante, y no se entiende.
  const r = salir(PROVS, '', 'AGROINSUMOS ARDISONE S.R.L.');
  assert.equal(r.txt, '', 'quedó el nombre escrito sin proveedor elegido');
  assert.equal(r.hid, '');
});

test('el elegido de verdad sobrevive al salir del campo', () => {
  const r = salir(PROVS, '7', 'AGROINSUMOS ARDISONE S.R.L.');
  assert.equal(r.hid, '7');
  assert.equal(r.txt, 'AGROINSUMOS ARDISONE S.R.L.');
  assert.equal(r.recargas, 0, 'volvió a pedir las operaciones sin que cambiara nada');
});

test('y si se edita el texto de uno ya elegido, deja de estar elegido', () => {
  // Elegir «ARDISONE» y después borrarle letras dejaba el id viejo pegado: se
  // facturaba a uno y en pantalla decía otro.
  const r = salir(PROVS, '7', 'AGROIN');
  assert.equal(r.hid, '');
  assert.equal(r.txt, '');
});

test('mientras el padrón no llegó, no dice «sin resultados»', () => {
  // Decir que no hay nada sobre una lista que todavía está viajando hace buscar
  // de nuevo algo que sí estaba — que es el problema que este PR viene a cerrar.
  const src = trozo(PANEL, 'function sgFgProvBuscar(){', '\r\n}');
  const caja = { innerHTML: '', style: { display: 'none' } };
  const mundo = {
    SGFG: { provs: [], pend: {}, provsListo: 0 },
    eid: (id) => (id === 'sg-fg-provlist' ? caja : { value: '' }),
    sgNorm: (v) => String(v || '').toLowerCase(),
    escH: (v) => String(v == null ? '' : v),
    sgMoney: (v) => '$' + v,
  };
  new Function(...Object.keys(mundo), src + '\nreturn sgFgProvBuscar;')(
    ...Object.values(mundo))();
  assert.match(caja.innerHTML, /Cargando el padrón/);
  assert.ok(!/Sin resultados/.test(caja.innerHTML));
});
