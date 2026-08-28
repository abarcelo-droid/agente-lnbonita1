// ══ ÓRDENES DE PAGO: CUÁNDO SE PIDIÓ, Y SI EL CHEQUE ES DE PAPEL ═══════════
//
// Pablo, 28/8/2026: «una columna con la fecha de creación de la solicitud para
// poder ordenarla por fecha de creación. Y dentro de cheques, cuando decidimos,
// poner dos box para tildar si son cheques físicos o e-cheqs, tanto para propios
// como para de terceros, para que todos sepan si el canal de pago es electrónico
// o no».
//
// No había NINGÚN test sobre este circuito: ningún archivo de test/ mencionaba
// sp_. (test/como_se_paga.test.mjs suena al tema pero es de San Gerónimo.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// LA REGLA REAL, IMPORTADA. Antes este test recortaba el texto de sp.js y
// reimplementaba la condición adentro del propio test: si alguien invertía el
// `if` en el router, el test seguía en verde porque corría su propia copia.
import { CANALES, ETIQUETA_CANAL, pideCanal, canalDeLinea, resumenCanales }
  from '../src/servicios/sp_canal.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = fs.readFileSync(path.join(RAIZ, 'src/rutas/sp.js'), 'utf8');
const DBSP = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sp.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ══ 1 · LA FECHA DE CREACIÓN ═══════════════════════════════════════════════

test('la columna existe, es ordenable y sale de creado_en', () => {
  assert.match(PANEL, /creada:\s+function\(s\)\{ return s\.creado_en \|\| ''; \}/);
  assert.match(PANEL, /spTh\(vista, 'creada', 'Pedida<br>el'/);
});

test('y el servidor ya la mandaba: no hizo falta tocar el SELECT', () => {
  // SELECT s.* sobre sp_solicitudes, y creado_en es columna de esa tabla.
  assert.match(SP, /SELECT s\.\*, \(SELECT COUNT\(\*\) FROM sp_eventos e WHERE e\.solicitud_id = s\.id\) AS n_eventos/);
  assert.match(DBSP, /creado_en\s+TEXT DEFAULT \(datetime\('now','localtime'\)\)/);
});

test('la fecha se muestra sin la hora, y la hora queda en el tooltip', () => {
  // Diez caracteres contra los dieciséis de «Espera desde»: las dos columnas de
  // fecha se distinguen por la forma, no sólo por el encabezado.
  const i = PANEL.indexOf("var creada = String(s.creado_en || '');");
  assert.ok(i > 0, 'no se calcula la fecha de creación en la fila');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /title="' \+ spEsc\(creada\.slice\(0, 16\)\)/);
  assert.match(b, /spEsc\(creada\.slice\(0, 10\)\) : '—'/);
});

test('«Pedida el» y «Espera desde» dicen cuál es cuál, o se leen como lo mismo', () => {
  // Una no cambia nunca; la otra se reinicia en cada paso. Dos fechas en la
  // misma tabla sin explicación son dos fechas que nadie usa.
  assert.match(PANEL, /Cuándo se pidió el pago\. No cambia nunca/);
  assert.match(PANEL, /Desde cuándo está parada en el paso actual\. Se reinicia cada vez que avanza/);
});

test('el orden por defecto NO cambió: lo urgente sigue arriba', () => {
  // La bandeja abre para trabajar. Ordenar por fecha es una decisión de quien
  // mira, no del sistema.
  assert.match(SP, /ORDER BY CASE s\.prioridad WHEN 'urgente' THEN 0 ELSE 1 END, s\.id DESC LIMIT 400/);
});

test('ordena como texto, y el formato lo permite', () => {
  // YYYY-MM-DD HH:MM:SS ordena lexicográficamente igual que cronológicamente.
  const fechas = ['2026-08-27 22:10:00', '2026-08-27 13:57:00', '2026-01-05 09:00:00'];
  const ord = fechas.slice().sort((a, b) => String(a).localeCompare(String(b), 'es',
    { numeric: true, sensitivity: 'base' }));
  assert.deepEqual(ord, ['2026-01-05 09:00:00', '2026-08-27 13:57:00', '2026-08-27 22:10:00']);
});

// ══ 2 · SIN BARRA DE DESPLAZAMIENTO LATERAL ════════════════════════════════

test('diez columnas y ninguna barra lateral', () => {
  // Esta pantalla no tenía el patrón: heredaba overflow-x:auto de .ab-table-wrap
  // y ninguna celda truncaba. Con una columna más la barra salía seguro.
  // El hidden apunta al wrapper de ESTA tabla, no a toda la sección: en la
  // sección viven además las tres tablas de Tiempos, la de Circuito y la cola de
  // avisos, que no declaran anchos — taparles el scroll sin darles anchos las
  // dejaba cortadas y sin forma de llegar al dato.
  assert.match(PANEL, /#sec-sp-pagos \.sp-wrap-seg \{ overflow-x:hidden !important \}/);
  assert.match(PANEL, /<div class="ab-table-wrap sp-wrap-seg">/);
  assert.match(PANEL, /#sec-sp-pagos table\.sp-tbl-seg \{ width:100%; table-layout:fixed \}/);
  assert.match(PANEL, /#sec-sp-pagos table\.sp-tbl-seg td \{[\s\S]{0,120}text-overflow:ellipsis/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sec-sp-pagos \.sp-wrap-seg \{ overflow-x:auto !important \}/);
});

test('el ENCABEZADO va aparte y NO se trunca', () => {
  // Compartiendo la regla de las celdas, «EN QUÉ PASO ESTÁ» y «AVISÉ AL
  // PROVEEDOR» se cortaban: la columna quedaba sin nombre y se llevaban puesta
  // la flecha de orden, que va al final. Dos clics daban dos resultados y no
  // había cómo saber cuál se estaba mirando.
  assert.match(PANEL, /#sec-sp-pagos table\.sp-tbl-seg th \{[^}]*white-space:normal/);
  assert.ok(!/#sec-sp-pagos table\.sp-tbl-seg th,#sec-sp-pagos table\.sp-tbl-seg td/.test(PANEL),
    'el th volvió a compartir la regla del td');
});

test('el MONTO no se trunca mudo: es el dato por el que se mira la fila', () => {
  // Va en monoespaciada y con la moneda adelante — «ARS 20.553.000,00» son
  // diecisiete caracteres — y alineado a la derecha, así que el navegador
  // recorta por la IZQUIERDA: «…553.000,00» se lee como quinientos mil. Era la
  // única celda truncable sin tooltip.
  assert.match(PANEL, /var mon = spMoney\(s\.monto, s\.moneda\);/);
  assert.match(PANEL, /<td class="sp-num" title="' \+ spEsc\(mon\) \+ '"><strong>' \+ spEsc\(mon\)/);
  assert.match(PANEL, /spTh\(vista, 'monto', 'Monto', 'width:13%;text-align:right'\)/);
});

test('el número de solicitud no se parte ni se recorta', () => {
  // SP-2026-0141 son doce caracteres fijos y es el identificador: partido en dos
  // renglones o cortado deja dos solicitudes que se leen igual. El badge
  // «urgente» baja a su propio renglón en vez de comerle el ancho.
  assert.match(PANEL, /spTh\(vista, 'numero', 'Nº', 'width:10%'\)/);
  assert.match(PANEL, /<div><span class="sp-bad sp-err">urgente<\/span><\/div>/);
  assert.ok(!/<td class="sp-libre"><strong>' \+ spEsc\(s\.numero\)/.test(PANEL));
});

test('la píldora del paso lleva su nombre completo en el title', () => {
  assert.match(PANEL, /<td title="' \+ spEsc\(s\.paso_nombre \|\| ''\)/);
});

test('la clase va SÓLO en la tabla de seguimiento', () => {
  // En esta misma sección viven las tablas de Tiempos y de Circuito, que no
  // declaran anchos: con table-layout:fixed quedarían en columnas iguales.
  assert.match(PANEL, /<table class="pa-tbl sp-tbl-seg"/);
  assert.equal((PANEL.match(/sp-tbl-seg"/g) || []).length, 1);
});

test('los anchos suman 100, en las dos formas de la tabla', () => {
  // «Pidió» no se dibuja en Mis solicitudes: ese 7% se reparte entre las dos
  // columnas que truncan.
  const i = PANEL.indexOf("function spTablaHtml(arr, vista) {");
  assert.ok(i > 0);
  const b = PANEL.slice(i, PANEL.indexOf('arr.forEach(function(s) {', i));
  const fijos = (b.match(/width:(\d+)%/g) || []).map((w) => Number(w.match(/\d+/)[0]));
  // 10 Nº + 8 Pedida + 13 Monto + 10 Paso + 11 Espera + 6 Pidió + 5 Avisé + 14 botones
  assert.equal(fijos.reduce((a, n) => a + n, 0), 77, 'los anchos fijos cambiaron');
  // Proveedor y Concepto son variables; con «Pidió» suman 23, sin ella 29.
  assert.match(b, /var wProv = propias \? '16%' : '13%', wConc = propias \? '13%' : '10%';/);
  assert.equal(77 + 13 + 10, 100);      // con Pidió
  assert.equal(77 - 6 + 16 + 13, 100);  // sin Pidió
});

test('las dos celdas que llevan prosa no se truncan', () => {
  // «Espera desde» cuelga de abajo «OK pedido a…» y «le toca a…»; la de botones
  // puede traer tres. Con nowrap se cortarían en la primera palabra, y un botón
  // partido al medio no se aprieta.
  assert.match(PANEL, /#sec-sp-pagos table\.sp-tbl-seg td\.sp-libre \{[\s\S]{0,90}white-space:normal/);
  assert.match(PANEL, /<td class="sp-chica sp-libre">' \+ spEsc\(String\(s\.paso_actual_desde/);
  assert.match(PANEL, /<td class="sp-libre" style="text-align:right">'\s*\n?\s*\+ '<button class="btn bo bs" onclick="spDetalleAbrir/);
});

test('y lo que sí se trunca lleva el texto completo en el title', () => {
  const i = PANEL.indexOf("var creada = String(s.creado_en || '');");
  const b = PANEL.slice(i, i + 4200);
  assert.match(b, /<td title="' \+ spEsc\(s\.proveedor_texto \|\| ''\) \+ '">/);
  assert.match(b, /<td class="sp-chica" title="' \+ spEsc\(String\(s\.concepto \|\| ''\)\) \+ '">/);
  assert.match(b, /<td class="sp-chica" title="' \+ spEsc\(s\.solicitante_nombre \|\| ''\) \+ '">/);
});

// ══ 3 · FÍSICO O E-CHEQ ════════════════════════════════════════════════════

test('el canal es columna aparte, no un cuarto valor de «tipo»', () => {
  // `tipo` tiene CHECK, y en SQLite ampliar un CHECK obliga a recrear la tabla
  // entera. Ya pasó con sp_adjuntos.
  assert.match(DBSP, /addCol\('sp_pago_detalle', 'canal', 'TEXT'\)/);
  assert.match(DBSP, /CHECK\(tipo IN \('transferencia','cheque_propio','cheque_terceros'\)\)/);
  // Y el CHECK sigue con los tres de siempre: nadie metió un cuarto tipo.
  assert.ok(!/cheque_propio_echeq/.test(DBSP));
});

test('sin CHECK en la columna nueva: el vocabulario se valida en JS', () => {
  const i = DBSP.indexOf("addCol('sp_pago_detalle', 'canal'");
  assert.ok(!/CHECK/.test(DBSP.slice(i, i + 60)));
  const SERV = fs.readFileSync(path.join(RAIZ, 'src/servicios/sp_canal.js'), 'utf8');
  assert.match(SERV, /export const CANALES = \['fisico', 'echeq'\];/);
});

test('obligatorio en los cheques, prohibido en la transferencia', () => {
  // Una transferencia ya es electrónica por definición: preguntarlo sería ruido.
  const i = SP.indexOf('function validarComposicion(');
  const b = SP.slice(i, SP.indexOf('\n}', SP.indexOf('return out;', i)));
  assert.match(b, /const canal = canalDeLinea\(tipo, p\.canal\);/);
  assert.match(b, /if \(pideCanal\(tipo\) && !canal\)/);
  assert.match(b, /no dice si es un cheque físico o un e-cheq/);
  // Y el mensaje dice QUÉ hacer, no sólo qué falta.
  assert.match(b, /Marcá \$\{CANALES\.map/);
});

test('la regla, corriéndola de verdad', () => {
  // Es LA función que usa el router, importada. Antes este test recortaba el
  // texto de sp.js y reimplementaba la condición acá adentro: eso no prueba
  // nada — invertir el `if` en el router lo dejaba en verde igual.
  assert.deepEqual(CANALES, ['fisico', 'echeq']);
  assert.equal(canalDeLinea('cheque_propio', 'echeq'), 'echeq');
  assert.equal(canalDeLinea('cheque_terceros', 'fisico'), 'fisico');
  assert.equal(canalDeLinea('cheque_propio', ''), null);
  assert.equal(canalDeLinea('cheque_propio', null), null);
  assert.equal(canalDeLinea('cheque_terceros', 'papel'), null, 'un valor inventado no entra');
  assert.equal(canalDeLinea('cheque_propio', '  echeq  '), 'echeq', 'se limpia el espacio');
  // La transferencia no lleva canal: guardarle uno sería inventar un dato.
  assert.equal(pideCanal('transferencia'), false);
  assert.equal(canalDeLinea('transferencia', 'echeq'), null);
  assert.equal(pideCanal('cheque_propio'), true);
  assert.equal(pideCanal('cheque_terceros'), true);
});

test('y el router usa ESA función, no una copia', () => {
  // Si la regla vuelve a vivir escrita adentro del router, el test de arriba
  // deja de proteger nada.
  assert.match(SP, /from '\.\.\/servicios\/sp_canal\.js'/);
  assert.match(SP, /const canal = canalDeLinea\(tipo, p\.canal\);/);
  assert.match(SP, /if \(pideCanal\(tipo\) && !canal\)/);
  assert.ok(!/const CANALES = \['fisico', 'echeq'\];/.test(SP), 'volvió la copia al router');
});

test('los dos son RADIO, no dos checkbox sueltos', () => {
  // Dos tildes independientes admiten «los dos», que es una mentira física: un
  // cheque o se imprime o se emite. El radio lo hace imposible por construcción
  // del navegador, no por una validación que alguien puede olvidarse de escribir.
  const i = PANEL.indexOf('function spCanalRadios(i, p) {');
  assert.ok(i > 0, 'no existe spCanalRadios');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /type="radio" name="sp-canal-/);
  assert.match(b, /\['fisico', 'echeq'\]/);
  // Y NO viene ninguno marcado: un default se acepta sin mirar y a las tres
  // semanas el dato no significa nada.
  assert.ok(!/checked'\s*:\s*''\s*\)\s*\+\s*'\s*checked/.test(b));
  assert.match(b, /p\.canal === c \? ' checked' : ''/);
});

test('los tildes salen en los DOS tipos de cheque, y en la transferencia no', () => {
  const i = PANEL.indexOf('spCanalRadios(i, p)', PANEL.indexOf('function spPagoRender()'));
  assert.ok(i > 0, 'no se dibujan en el editor');
  const b = PANEL.slice(i - 300, i + 120);
  // esCheque es tipo !== 'transferencia': cubre propio Y terceros de una.
  assert.match(b, /esCheque \? '<div style="margin-top:3px">' \+ spCanalRadios\(i, p\)/);
});

test('el canal VIAJA en el payload: si no, se tilda y el error es mudo', () => {
  const i = PANEL.indexOf('body.pagos = SP.pagos.map(function(p) {');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /canal: \(p\.tipo === 'transferencia' \? null : \(p\.canal \|\| null\)\)/);
});

test('y se guarda: columna en el INSERT y argumento en el run', () => {
  // Uno solo de los dos deja NULL en silencio.
  assert.match(SP, /INSERT INTO sp_pago_detalle \(solicitud_id, tipo, importe, fecha, codigo, canal, notas, orden, creado_por_id\)/);
  assert.match(SP, /VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
  assert.match(SP, /insP\.run\(s\.id, p\.tipo, p\.importe, p\.fecha, p\.codigo, p\.canal, p\.notas, i, req\.user\.id\)/);
});

test('la línea nueva y la de arranque nacen con el campo', () => {
  // Sin esto el objeto no tiene la clave, el radio nunca queda checked y el
  // payload manda undefined.
  assert.match(PANEL, /\{ tipo: tipo, importe: '', fecha: '', codigo: '', canal: '', auto: true \}/);
  assert.match(PANEL, /\{ tipo: tipo, importe: falta > 0 \? falta : '', fecha: '', codigo: '', canal: '', auto: false \}/);
  assert.match(PANEL, /\{ tipo: 'transferencia', importe: s\.monto, fecha: '', codigo: '', canal: '', auto: true \}/);
});

// ══ 4 · QUE TODOS SE ENTEREN ═══════════════════════════════════════════════

test('el canal va en la línea de cada cheque del mail', () => {
  const i = SP.indexOf('function textoComposicion(');
  const b = SP.slice(i, i + 1800);
  assert.match(b, /ETIQUETA_CANAL\[p\.canal\] \? ' · ' \+ ETIQUETA_CANAL\[p\.canal\]/);
  // Y el cheque viejo lo dice: en blanco se lee como «no hace falta», que es lo
  // que significa el vacío en una transferencia.
  assert.match(b, /pideCanal\(p\.tipo\) \? ' · canal sin informar' : ''/);
});

test('y un resumen antes del total: cuántos van por homebanking', () => {
  // El que confecciona necesita saber cuántos va a cargar ANTES de leer renglón
  // por renglón.
  const i = SP.indexOf('function textoComposicion(');
  const b = SP.slice(i, i + 1600);
  assert.match(b, /const resumen = resumenCanales\(pagos\);/);
  const res = b.indexOf('resumenCanales(pagos)');
  const tot = b.indexOf('TOTAL:');
  assert.ok(res > 0 && tot > res, 'el resumen va ANTES del total (res=' + res + ' tot=' + tot + ')');
});

test('el resumen, corriéndolo', () => {
  assert.equal(resumenCanales([{ tipo: 'transferencia' }]), '', 'sin cheques no dice nada');
  // Uno solo se dice en singular: «De los 1 cheque» está mal escrito y se lee
  // como un error del sistema.
  assert.equal(resumenCanales([{ tipo: 'cheque_propio', canal: 'echeq' }]),
    'Del cheque: 1 e-cheq.');
  assert.equal(resumenCanales([
    { tipo: 'cheque_propio', canal: 'echeq' },
    { tipo: 'cheque_propio', canal: 'echeq' },
    { tipo: 'cheque_terceros', canal: 'fisico' },
  ]), 'De los 3 cheques: 2 e-cheqs y 1 físico.');
  // Y las líneas viejas, sin canal, se cuentan aparte en vez de desaparecer: un
  // resumen que no cierra contra la cantidad de cheques se deja de leer.
  assert.equal(resumenCanales([
    { tipo: 'cheque_propio', canal: 'echeq' },
    { tipo: 'cheque_propio', canal: null },
  ]), 'De los 2 cheques: 1 e-cheq y 1 sin informar.');
  // Tres partes se enumeran con comas, no con dos «y».
  assert.equal(resumenCanales([
    { tipo: 'cheque_propio', canal: 'echeq' },
    { tipo: 'cheque_propio', canal: 'fisico' },
    { tipo: 'cheque_terceros', canal: null },
  ]), 'De los 3 cheques: 1 e-cheq, 1 físico y 1 sin informar.');
  // La transferencia no cuenta como cheque.
  assert.equal(resumenCanales([
    { tipo: 'transferencia', canal: null },
    { tipo: 'cheque_propio', canal: 'fisico' },
  ]), 'Del cheque: 1 físico.');
  assert.equal(ETIQUETA_CANAL.echeq, 'e-cheq');
});

test('el que FIRMA también recibe el detalle del pago', () => {
  // Antes iba sólo al que confecciona. Firmar un papel o autorizar en el
  // homebanking es literalmente el acto del que firma, y su mail no decía nada.
  assert.match(SP, /\['confeccion', 'firma'\]\.includes\(paso\.hito\)/);
});

test('la pantalla de detalle lo muestra en la línea, no en una columna nueva', () => {
  // Los dos colspan de esa tabla están clavados en 4 y en 2: una columna más los
  // rompe en silencio.
  const i = PANEL.indexOf("return '<tr><td class=\"sp-chica\">' + spEsc(SP_PAGO_ETQ[t])");
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1300);
  assert.match(b, /p\.canal === 'echeq' \? ' <span class="sp-bad sp-echeq">e-cheq<\/span>'/);
  assert.match(b, /p\.canal === 'fisico'\s*\? ' <span class="sp-bad sp-gris">físico<\/span>'/);
  assert.match(PANEL, /\.sp-echeq \{ background:#dbeafe; color:#1e40af \}/);
});

test('y el cheque VIEJO dice que le falta el dato', () => {
  // Sin la tercera rama, una línea cargada antes de este cambio se veía igual
  // que una marcada: nadie podía saber que el canal no estaba. Va condicionada
  // por el TIPO, porque en una transferencia el vacío es correcto.
  const i = PANEL.indexOf("return '<tr><td class=\"sp-chica\">' + spEsc(SP_PAGO_ETQ[t])");
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /t === 'transferencia' \? ''/);
  assert.match(b, /<span class="sp-bad sp-warn">canal sin informar<\/span>/);
});

test('el instructivo lo explica: se imprime y se manda por mail a los nuevos', () => {
  assert.match(PANEL, /En cada cheque hay que marcar si es físico o e-cheq/);
  assert.match(PANEL, /cuáles son e-cheq y cuáles van en papel/);
  // Y la ayuda del propio modal donde se decide.
  assert.match(PANEL, /no es lo mismo imprimirlo y firmarlo a mano que emitirlo en el homebanking/);
});

// ══ 5 · LAS LÍNEAS VIEJAS ══════════════════════════════════════════════════

test('las líneas ya cargadas quedan en NULL y no se les inventa el canal', () => {
  // No se puede saber el canal de un cheque ya emitido, y poner «físico» porque
  // es viejo mete una afirmación falsa en un registro que alguien va a citar.
  assert.ok(!/UPDATE sp_pago_detalle SET canal=/.test(DBSP), 'se rellenaron las viejas');
  assert.ok(!/addCol\('sp_pago_detalle', 'canal', "TEXT DEFAULT/.test(DBSP));
  assert.match(DBSP, /NULL es un valor con significado/);
});

test('y la base aguanta una composición mixta de verdad', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sp_pago_detalle (id INTEGER PRIMARY KEY, solicitud_id INTEGER,
    tipo TEXT NOT NULL CHECK(tipo IN ('transferencia','cheque_propio','cheque_terceros')),
    importe REAL NOT NULL CHECK(importe > 0), fecha TEXT, codigo TEXT, canal TEXT,
    notas TEXT, orden INTEGER DEFAULT 0)`);
  const ins = db.prepare(`INSERT INTO sp_pago_detalle
    (solicitud_id, tipo, importe, fecha, codigo, canal, orden) VALUES (?,?,?,?,?,?,?)`);
  ins.run(1, 'transferencia', 100, '2026-09-01', null, null, 0);
  ins.run(1, 'cheque_propio', 200, '2026-10-01', null, 'echeq', 1);
  ins.run(1, 'cheque_terceros', 300, '2026-11-01', '00012345', 'fisico', 2);
  const filas = db.prepare('SELECT * FROM sp_pago_detalle ORDER BY orden').all();
  assert.equal(filas.length, 3);
  assert.equal(filas[0].canal, null);
  assert.equal(filas[1].canal, 'echeq');
  assert.equal(filas[2].canal, 'fisico');
  // El mismo pago con un e-cheq y un cheque en papel: por eso el canal va en la
  // LÍNEA y no en la solicitud.
  const ech = db.prepare("SELECT COUNT(*) n FROM sp_pago_detalle WHERE canal='echeq'").get().n;
  assert.equal(ech, 1);
});
