// ══ COMO SE PACTÓ, ASÍ SE CIERRA ═══════════════════════════════════════════
//
// Pablo, 28/8/2026: «esta partida ingresó con bulto; por qué cuando voy a cerrar
// precio se lo tengo que cerrar por kilo… es imposible así, la lógica es muy
// fácil: bulto, bulto; kilo, kilo. No entiendo la dinámica y lógica que estás
// usando para ponerme todo por kilo».
//
// Ya lo había dicho el 27/8 —«el precio se debe poder editar, siempre respetando
// el precio que se ingresó en la orden de compra: si es por kilo por kilo, si es
// por bulto por bulto»— y se aplicó SÓLO en el modal de corregir la partida. El
// de cerrar el precio de pizarra seguía pidiendo $/kg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

const cuerpo = (nombre, largo = 3000) => {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  return PANEL.slice(i, i + largo);
};

// ── LA UNIDAD LA MANDA LA ORDEN ────────────────────────────────────────────

test('cerrar precio arranca en la unidad en que se pactó la compra', () => {
  const b = cuerpo('function sgPrecioOpen(loteId, codigo, kg, refKg){');
  assert.match(b, /it\.modo_carga === 'bulto' && kpb/);
  assert.match(b, /uni\.value = porBulto \? 'bulto' : 'kg';/);
  // Y lo dice, para que cambiarla sea una decisión y no un descuido.
  assert.match(b, /La orden se cerró <b>por/);
});

test('el modal ya no está clavado en $/kg', () => {
  const i = PANEL.indexOf('id="sg-precio-modal"');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /<select id="sg-precio-uni" onchange="sgPrecioUni\(\)"/);
  assert.match(b, /<option value="bulto">por bulto<\/option>/);
  assert.ok(!/Precio del día por kg/.test(b), 'quedó el rótulo viejo');
  assert.ok(!/placeholder="\$\/kg"/.test(b));
});

test('sin kilos por bulto no se ofrece la conversión', () => {
  // Un lote a granel no tiene cajón: dejar elegir «por bulto» sin factor daría
  // una división por cero disfrazada.
  const b = cuerpo('function sgPrecioOpen(loteId, codigo, kg, refKg){');
  assert.match(b, /uni\.disabled = !kpb;/);
  assert.match(b, /sin kilos por bulto, se cierra por kilo/);
});

test('la unidad sale del MISMO lado que en el modal de corregir', () => {
  // Si cada pantalla la buscara por su cuenta, podrían contestar distinto sobre
  // la misma partida.
  const b = cuerpo('function sgPrecioOpen(loteId, codigo, kg, refKg){');
  assert.match(b, /\(SG\.ocVerLotes \|\| \[\]\)\.filter/);
  assert.match(b, /\(\(SG\.ocVerData && SG\.ocVerData\.items\) \|\| \[\]\)\.filter/);
  assert.match(b, /sgLoteEdKpb\(lote\)/);
  // El modal de corregir usa exactamente lo mismo.
  const c = cuerpo('var uniOrden = (it && it.modo_carga === ', 200);
  assert.match(c, /modo_carga === 'bulto' && kpb/);
});

// ── LA CONVERSIÓN ──────────────────────────────────────────────────────────

test('la cuenta, corriéndola', () => {
  // El precio se guarda SIEMPRE por kilo —es la unidad con la que corre el costo
  // en todo el módulo—, así que lo tipeado por bulto se divide por el factor.
  // Guardar el número tipeado sin convertir multiplicaría el costo por dieciséis.
  const i = PANEL.indexOf('function sgPrecioKg(){');
  assert.ok(i > 0, 'no existe sgPrecioKg');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  const hacer = (valor, unidad, kpb) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('eid', 'SG', src + '; return sgPrecioKg;')(
      (id) => ({ 'sg-precio-valor': { value: valor }, 'sg-precio-uni': { value: unidad } }[id]),
      { precioLote: { kpb } });
    return f();
  };
  // Un cajón de 16 kg a $22.000 el cajón = $1.375 el kilo.
  assert.equal(hacer('22000', 'bulto', 16), 1375);
  // Por kilo no se toca.
  assert.equal(hacer('1375', 'kg', 16), 1375);
  // Sin factor, aunque diga bulto, no se inventa una división.
  assert.equal(hacer('22000', 'bulto', 0), 22000);
  assert.equal(hacer('', 'bulto', 16), 0);
});

test('y el equivalente se muestra siempre, no hay que creerle a la cuenta', () => {
  // Se tipea en una unidad y se guarda en la otra: sin ver el número que va a
  // quedar registrado, hay que confiar a ciegas.
  const b = cuerpo('function sgPrecioCalc(){');
  assert.match(b, /sgMoney\(pk\) \+ ' \/kg'/);
  assert.match(b, /sgMoney\(pk \* kpb\) \+ ' por bulto'/);
});

test('lo que se manda al servidor es el precio POR KILO', () => {
  const b = cuerpo('function sgPrecioGuardar(){');
  assert.match(b, /var p = sgPrecioKg\(\);/);
  assert.match(b, /\{precio_unitario_kg:p\}/);
  // Y el servidor sigue guardando por kilo: la unidad es cosa de la pantalla.
  assert.match(SG, /const precio = Number\(req\.body\.precio_unitario_kg\);/);
  assert.match(SG, /const costoBase = \(lote\.kg_reales \|\| 0\) \* precio;/);
});

// ── LO QUE SE VE ANTES DE DECIDIR ──────────────────────────────────────────

test('el encabezado dice los bultos, no sólo los kilos', () => {
  // La orden se pactó en cajones: mostrar sólo «1.056 kg» obliga a dividir para
  // saber de cuántos cajones se está hablando.
  const b = cuerpo('function sgPrecioOpen(loteId, codigo, kg, refKg){');
  assert.match(b, /nr\(Math\.round\(kg\/kpb\)\)\+' bultos de '\+nr\(kpb\)\+' kg'/);
});

test('y la referencia de venta también se muestra por bulto', () => {
  // Es contra lo que se compara el precio que se está por cerrar: en cajones
  // contra kilos no se compara nada.
  const b = cuerpo('function sgPrecioOpen(loteId, codigo, kg, refKg){');
  assert.match(b, /sgMoney\(ref\*kpb\)\+'<\/b> por bulto/);
});

test('el margen contra la referencia sigue calculándose sobre el precio por kilo', () => {
  // Las dos puntas tienen que estar en la misma unidad o el porcentaje no
  // significa nada.
  const b = cuerpo('function sgPrecioCalc(){');
  assert.match(b, /var m = Math\.round\(\(ref - pk\) \/ ref \* 1000\) \/ 10;/);
  assert.match(b, /se estaría pagando MÁS de lo que se espera vender/);
});

// ══ LAS OTRAS PUERTAS ══════════════════════════════════════════════════════
//
// Pablo: «podemos resolverlo de una vez». Arreglar sólo la que reportó dejaba
// cuatro más pidiendo kilos sobre partidas pactadas por cajón.

const OCPDF = fs.readFileSync(path.join(RAIZ, 'src/servicios/ocPDF.js'), 'utf8');

// ── LA RAÍZ ────────────────────────────────────────────────────────────────

test('LA DESCARGA SIN ORDEN GUARDA EN QUÉ UNIDAD ENTRÓ', () => {
  // Acá estaba el motivo de que le saliera todo por kilo: la orden nacida de una
  // descarga guardaba los cajones EN EL LOTE pero dejaba modo_carga en NULL en el
  // ítem, que es de donde todo el módulo lee la unidad. Con NULL cada pantalla
  // adivina — y adivinan distinto: la deuda con el productor se calcula por cajón
  // y la liquidación pide el precio por kilo, sobre la misma partida.
  // El de la descarga sin orden, no el del alta normal: hay dos.
  const i = SG.indexOf('LA UNIDAD EN QUE ENTRÓ, GUARDADA');
  assert.ok(i > 0, 'no está el arreglo de la raíz');
  const b = SG.slice(i, i + 2600);
  assert.match(b, /precio_estimado_por_kg, observaciones_item, modo_carga, kg_por_bulto\)/);
  assert.match(b, /const modo = bltItem > 0 \? 'bulto' : 'kilo';/);
  assert.match(b, /Si vino con cajones, se pactó por cajón/);
});

test('y el factor sale de los lotes, que es donde se contaron', () => {
  const i = SG.indexOf('LA UNIDAD EN QUE ENTRÓ, GUARDADA');
  const b = SG.slice(i, i + 2600);
  assert.match(b, /const kpbLote = lotes\.map\(\(l\) => Number\(l\.kg_por_bulto\) \|\| 0\)\.filter/);
  // Y si no vino cargado, sale de dividir: los kilos y los cajones sí están.
  assert.match(b, /bltItem > 0 && kgItem > 0 \? Math\.round\(\(kgItem \/ bltItem\) \* 1e6\) \/ 1e6 : null/);
});

// ── CAMBIAR EL PRECIO DE LA ORDEN ──────────────────────────────────────────

test('cambiar el precio de la orden respeta la unidad de cada renglón', () => {
  // Una orden puede tener un producto por cajón y otro por kilo: la unidad no
  // puede ser del encabezado de la tabla.
  const b = cuerpo('function sgOcpPorBulto(it){', 1800);
  assert.match(b, /it\.modo === 'bulto' && it\.kpb > 0/);
  assert.match(cuerpo('function sgOcpRender(){', 2200), /se pactó por '/);
  assert.match(cuerpo('function sgOcpRender(){', 2200), /\$ por bulto' : '\$ por kg'/);
  // El encabezado deja de decir "$ / kg" para todos.
  assert.match(PANEL, /if \(th\) th\.textContent = 'Precio';/);
});

test('y la conversión de esa pantalla, corriéndola', () => {
  const i = PANEL.indexOf('function sgOcpVista(it){');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  const j = PANEL.indexOf('function sgOcpPorBulto(it){');
  const srcPb = PANEL.slice(j, PANEL.indexOf('\n', j) + 1);
  // eslint-disable-next-line no-new-func
  const vista = new Function(srcPb + src + '; return sgOcpVista;')();
  // $1.375 el kilo, cajón de 16 kg → se muestra $22.000 el cajón.
  assert.equal(vista({ modo: 'bulto', kpb: 16, precio: 1375 }), 22000);
  // Por kilo no se toca.
  assert.equal(vista({ modo: 'kilo', kpb: 16, precio: 1375 }), 1375);
  // Sin factor tampoco.
  assert.equal(vista({ modo: 'bulto', kpb: 0, precio: 1375 }), 1375);
  assert.equal(vista({ modo: 'bulto', kpb: 16, precio: '' }), '');
});

test('lo que manda al servidor sigue siendo por kilo', () => {
  const b = cuerpo('function sgOcpSet(i, valor){', 900);
  assert.match(b, /sgOcpUpd\(i, sgOcpPorBulto\(it\) && n > 0 \? \(n \/ it\.kpb\) : n\);/);
  assert.match(PANEL, /return \{ oc_item_id: it\.oc_item_id, precio_por_kg: Number\(it\.precio\) \};/);
});

// ── COMPLETAR LA ORDEN (lo que entró sin orden) ────────────────────────────

test('completar la orden pide el precio en la unidad en que entró', () => {
  const b = cuerpo('function sgSoPorBulto(it){', 1200);
  assert.match(b, /String\(it\.modo_carga \|\| ''\) === 'bulto' && Number\(it\.kg_por_bulto\) > 0/);
  assert.match(PANEL, /\$ por bulto' : '\$ por kg'\) \+ '"'/);
});

test('y el servidor le manda la unidad, que antes no viajaba', () => {
  const i = SG.indexOf("const items = db.prepare(`SELECT i.id, i.producto_id, i.kg_estimados");
  assert.ok(i > 0);
  const b = SG.slice(i, i + 1200);
  assert.match(b, /i\.modo_carga,/);
  assert.match(b, /COALESCE\(i\.kg_por_bulto, ps\.factor_conversion\) AS kg_por_bulto/);
});

test('y de paso, los bultos son bultos y no la cantidad de lotes', () => {
  // Había un COUNT(*) de sg_lotes: una descarga de 90 cajones partida en dos
  // calidades decía «2 bulto(s)».
  const i = SG.indexOf("const items = db.prepare(`SELECT i.id, i.producto_id, i.kg_estimados");
  const b = SG.slice(i, i + 1200);
  assert.match(b, /SELECT COALESCE\(SUM\(l\.bultos\),0\) FROM sg_lotes l WHERE l\.oc_item_id = i\.id AND l\.activo = 1\) AS bultos/);
  assert.ok(!/SELECT COUNT\(\*\) FROM sg_lotes l WHERE l\.oc_item_id = i\.id AND l\.activo = 1\) AS bultos/.test(b));
});

test('el total de esa pantalla se calcula con el precio ya llevado a kilo', () => {
  const b = cuerpo('function sgSoTotal(){', 900);
  assert.match(b, /var pk = sgSoPrecioKg\(it, i\);/);
  assert.match(b, /var sub = pk \* \(Number\(it\.kg_estimados\) \|\| 0\);/);
});

// ── EL PAPEL QUE VE EL PRODUCTOR ───────────────────────────────────────────

test('la orden impresa muestra el precio en la unidad pactada', () => {
  // Decía «$/kg» siempre: una orden cerrada por cajón le mostraba al productor un
  // número que él nunca dio.
  assert.match(OCPDF, /doc\.text\('Precio', 168, y \+ 5\.3, \{ align: 'right' \}\);/);
  assert.ok(!/doc\.text\('\$\/kg'/.test(OCPDF));
  assert.match(OCPDF, /const porBulto = it\.modo_carga === 'bulto' && kpb > 0;/);
  assert.match(OCPDF, /money\(precio\) \+ \(porBulto \? '\/blt' : '\/kg'\)/);
});

test('y el subtotal del papel se arma con esa misma unidad', () => {
  // kg × $/kg no es lo que se le va a pagar cuando se pactó por cajón: los
  // cajones no pesan lo nominal y la cuenta no cierra contra la deuda del
  // sistema.
  assert.match(OCPDF, /porBulto \? bultos \* Number\(pk\) \* kpb : Number\(it\.kg_estimados \|\| 0\) \* Number\(pk\)/);
  // Y el servidor le manda el factor.
  assert.match(SG, /COALESCE\(i\.kg_por_bulto, ps\.factor_conversion\) AS kg_por_bulto_efectivo\s*\n?\s*FROM sg_oc_items i/);
});
