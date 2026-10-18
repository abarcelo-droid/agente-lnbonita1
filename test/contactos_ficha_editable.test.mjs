// ══ LA FICHA SE EDITA DONDE SE LEE ════════════════════════════════════════
//
// Andy, 18/10/2026: «prefiero algo más como que entrás a la ficha y ahí ves
// todo, más visual, y de ahí mismo editás».
//
// Esto NO se prueba leyendo el código: se le ARRANCA el mecanismo a
// panel.html, se le monta un DOM de mentira y se lo usa — se toca un campo, se
// escribe, se sale, y se mira qué se mandó al servidor. Un test que verifique
// que el archivo dice «ctCmpEditar» no prueba nada.
//
// ── LO QUE PUEDE ESTAR MAL SIN QUE SE NOTE ────────────────────────────────
// Que un campo guarde cuando no cambió nada —y pise lo que un compañero acaba
// de corregir—, que Escape guarde igual, que el error deje el campo con el
// valor nuevo haciendo creer que entró, o que se mande el objeto entero en vez
// del campo tocado. Todo eso se ve idéntico en pantalla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// El trozo de panel.html que define el mecanismo, tal cual está escrito.
function fn(nombre) {
  let i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no está: function ' + nombre);
  // El `async` va ANTES de `function` y hay que llevárselo: sin él, el cuerpo tiene
  // un await adentro de una función común y ni siquiera compila. Pasó.
  if (PANEL.slice(i - 6, i) === 'async ') i -= 6;
  const j = PANEL.indexOf('\r\n}', i);
  assert.ok(j > i, 'no cierra: ' + nombre);
  return PANEL.slice(i, j + 3);
}
function constante(nombre) {
  const re = new RegExp('^const ' + nombre + ' = [\\s\\S]*?;$', 'm');
  const m = re.exec(PANEL);
  assert.ok(m, 'no está: const ' + nombre);
  return m[0];
}

// ── EL DOM DE MENTIRA ─────────────────────────────────────────────────────
// Sólo lo que el mecanismo toca. Cada pedacito está porque alguna línea del
// código lo usa: si mañana usa algo más, el test se cae acá y hay que mirarlo.
function nodo(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: {}, dataset: {},
    value: '', type: '', rows: 0, offsetWidth: 100,
    _clases: new Set(), _html: '', _txt: '', _oyentes: {},
    get className() { return [...el._clases].join(' '); },
    set className(v) { el._clases = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); el._txt = String(v).replace(/<[^>]*>/g, ''); },
    get textContent() { return el._txt; },
    set textContent(v) { el._txt = String(v); el._html = String(v); },
    classList: {
      add: (c) => el._clases.add(c),
      remove: (c) => el._clases.delete(c),
      contains: (c) => el._clases.has(c),
      toggle: (c) => (el._clases.has(c) ? el._clases.delete(c) : el._clases.add(c)),
    },
    setAttribute: (k, v) => { el.dataset['attr_' + k] = v; },
    appendChild: (h) => { h.parentNode = el; el.children.push(h); return h; },
    remove: () => {
      if (!el.parentNode) return;
      el.parentNode.children = el.parentNode.children.filter((x) => x !== el);
      el.parentNode = null;
    },
    querySelector: (sel) => {
      const tags = sel.split(',').map((x) => x.trim().toUpperCase());
      return el.children.find((c) => tags.includes(c.tagName)) || null;
    },
    focus: () => { el._foco = true; },
    select: () => { el._sel = true; },
    addEventListener: (ev, f) => { (el._oyentes[ev] = el._oyentes[ev] || []).push(f); },
    disparar: (ev, arg) => (el._oyentes[ev] || []).forEach((f) => f(arg || {
      preventDefault() {},
    })),
  };
  return el;
}

// El entorno donde corre el mecanismo: las funciones de panel.html más los
// mínimos que necesitan.
function entorno(respuesta) {
  const pedidos = [];
  const ctx = {
    CT_CHIP: {
      proveedor: ['ct-ch-prov', 'Proveedor'], cliente: ['ct-ch-cli', 'Cliente'],
      ambos: ['ct-ch-amb', 'Las dos'], otro: ['ct-ch-otro', 'Otro'],
    },
    CT_FICHA: null, CT_EMP: null, CT_OPC: { empresas: [] },
    document: { createElement: (t) => nodo(t) },
    pedidos,
    // ctApi de mentira: anota qué se pidió y contesta lo que el test quiera.
    async ctApi(url, opts) {
      pedidos.push({ url, metodo: (opts || {}).method, cuerpo: JSON.parse((opts || {}).body || '{}') });
      const r = typeof respuesta === 'function' ? respuesta(url, opts) : respuesta;
      if (r instanceof Error) throw r;
      return r || { ok: true };
    },
    ctRecargar() { ctx.recargado = (ctx.recargado || 0) + 1; },
    ctPintarFicha() { ctx.repintado = (ctx.repintado || 0) + 1; },
    ctPintarEmpresa() { ctx.repintado = (ctx.repintado || 0) + 1; },
    ctAbrir() { ctx.repintado = (ctx.repintado || 0) + 1; },
  };
  const codigo = [
    constante('ctEsc'),
    constante('CT_CMP_REPINTA'),
    fn('ctCampo'), fn('ctCmpEditar'), fn('ctCmpGuardar'),
    'return { ctCampo, ctCmpEditar, ctCmpGuardar };',
  ].join('\n');
  const claves = Object.keys(ctx);
  // eslint-disable-next-line no-new-func
  const api = new Function(...claves, codigo)(...claves.map((k) => ctx[k]));
  // Lo que el código asigna a CT_FICHA/CT_EMP queda adentro del closure, así que
  // el test mira los pedidos y el DOM, que es lo que de verdad se ve.
  return { ctx, ...api };
}

// Arma el <div class="ct-cmp"> con su .ct-cv adentro, como lo deja ctCampo().
function campoMontado(e, ent, id, nombre, valor, opts) {
  const html = e.ctCampo(ent, id, nombre, valor, opts);
  const box = nodo('div');
  const m = /data-ent="([^"]*)" data-id="([^"]*)" data-campo="([^"]*)" data-tipo="([^"]*)"/.exec(html);
  assert.ok(m, 'ctCampo no dejó los data-*: ' + html.slice(0, 160));
  box.dataset.ent = m[1]; box.dataset.id = m[2]; box.dataset.campo = m[3]; box.dataset.tipo = m[4];
  const vac = /data-vacio="([^"]*)"/.exec(html);
  if (vac) box.dataset.vacio = vac[1];
  const lista = /data-lista="([^"]*)"/.exec(html);
  if (lista) box.dataset.lista = lista[1];
  const cv = nodo('div');
  cv.className = /class="(ct-cv[^"]*)"/.exec(html)[1];
  cv.dataset.v = (/data-v="([^"]*)"/.exec(html) || [, ''])[1];
  cv.textContent = valor == null ? '' : String(valor);
  box.appendChild(cv);
  return { box, cv, html };
}

// ── LO QUE DIBUJA ─────────────────────────────────────────────────────────
test('UN CAMPO SE VE COMO TEXTO, no como un casillero', () => {
  const e = entorno();
  const { html } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño', { etiqueta: 'Cargo' });
  assert.match(html, /class="ct-cv"/);
  assert.match(html, />Dueño</);
  assert.ok(!/<input/.test(html), 'dibujó un casillero de entrada');
  assert.match(html, /onclick="ctCmpEditar\(this\)"/);
});

test('y uno vacío lo dice en gris, en vez de quedar en blanco', () => {
  // Un hueco en blanco no se lee como «falta esto»: se lee como que no hay nada
  // que poner ahí, y entonces nadie lo completa nunca.
  const e = entorno();
  const { html } = campoMontado(e, 'persona', 12, 'cargo', '', { vacio: 'sin cargo' });
  assert.match(html, /ct-cv-vacio/);
  assert.match(html, />sin cargo</);
});

test('LO QUE SE ESCRIBIÓ NO SE INTERPRETA COMO HTML', () => {
  // Una nota con un < adentro no puede romper la ficha, ni ejecutar nada: lo
  // escribe el comercial y lo lee cualquiera del equipo.
  const e = entorno();
  const malicioso = '<img src=x onerror=alert(1)> "x" & <b>';
  const { html } = campoMontado(e, 'persona', 12, 'notas', malicioso);

  // Lo que importa no es que la cadena «onerror» no aparezca —como texto suelto es
  // inofensivo— sino que NO QUEDE NINGUNA ETIQUETA NI NINGÚN ATRIBUTO nuevos. Con el
  // < escapado no hay etiqueta, y con la comilla escapada no se puede salir del
  // data-v="…" para inventar uno.
  assert.ok(!/<img/.test(html), 'dejó pasar una etiqueta: ' + html);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-v="&lt;img[^"]*&quot;x&quot;[^"]*&amp;[^"]*&lt;b&gt;"/,
    'el valor no quedó escapado adentro del atributo');

  // Y el contador de etiquetas no se movió: el valor no agregó ninguna. Los `&lt;`
  // no cuentan porque no llevan `<` adentro — es justamente lo que se está probando.
  const sinValor = campoMontado(e, 'persona', 12, 'notas', 'texto normal').html;
  assert.equal((html.match(/</g) || []).length, (sinValor.match(/</g) || []).length,
               'el valor metió aperturas de etiqueta de más');
});

// ── LO QUE PASA AL TOCARLO ────────────────────────────────────────────────
test('al tocarlo aparece un casillero con el valor que había, listo para escribir', () => {
  const e = entorno();
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  const inp = box.querySelector('input,select,textarea');
  assert.ok(inp, 'no apareció el casillero');
  assert.equal(inp.value, 'Dueño');
  assert.equal(inp._foco, true, 'no quedó con el foco: hay que hacer un clic de más');
  assert.equal(cv.style.display, 'none', 'quedaron el texto y el casillero a la vez');
});

test('el de varias líneas es un textarea, no un renglón', () => {
  const e = entorno();
  const { box, cv } = campoMontado(e, 'persona', 12, 'notas', 'una\ndos\ntres',
    { tipo: 'textarea' });
  e.ctCmpEditar(cv);
  const inp = box.querySelector('input,select,textarea');
  assert.equal(inp.tagName, 'TEXTAREA');
  assert.ok(inp.rows >= 3, 'arrancó con ' + inp.rows + ' renglones');
});

test('DOS CLICS NO ABREN DOS CASILLEROS', () => {
  const e = entorno();
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  e.ctCmpEditar(cv);
  assert.equal(box.children.filter((c) => c.tagName === 'INPUT').length, 1);
});

// ── LO QUE SE GUARDA, Y LO QUE NO ─────────────────────────────────────────
test('AL SALIR GUARDA, y manda SÓLO el campo que se tocó', async () => {
  // Si mandara el objeto entero, lo que un compañero cambió en otro campo
  // mientras tanto se pisaría sin que nadie lo note.
  const e = entorno({ ok: true, contacto: { id: 12, cargo: 'Encargado' } });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  const inp = box.querySelector('input,select,textarea');
  inp.value = 'Encargado';
  inp.disparar('blur');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(e.ctx.pedidos.length, 1);
  assert.equal(e.ctx.pedidos[0].url, '/12');
  assert.equal(e.ctx.pedidos[0].metodo, 'PATCH');
  assert.deepEqual(e.ctx.pedidos[0].cuerpo, { cargo: 'Encargado' });
});

test('y la empresa va a su propia dirección', async () => {
  const e = entorno({ ok: true, empresa: { id: 4 } });
  const { box, cv } = campoMontado(e, 'empresa', 4, 'zona', 'Tunuyán');
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').value = 'Valle de Uco';
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.ctx.pedidos[0].url, '/empresas/4');
  assert.deepEqual(e.ctx.pedidos[0].cuerpo, { zona: 'Valle de Uco' });
});

test('SI NO CAMBIÓ NADA NO SE PIDE NADA', async () => {
  // Tocar un campo para leerlo mejor y salir no puede escribir en la base: con
  // varios mirando la misma ficha, eso pisa lo que otro acaba de corregir.
  const e = entorno({ ok: true });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(e.ctx.pedidos, []);
});

test('ESCAPE CANCELA: ni guarda, ni deja lo tipeado', async () => {
  const e = entorno({ ok: true });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  const inp = box.querySelector('input,select,textarea');
  inp.value = 'me arrepentí';
  inp.disparar('keydown', { key: 'Escape', preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(e.ctx.pedidos, [], 'guardó igual');
  assert.equal(cv.dataset.v, 'Dueño');
  assert.equal(cv.style.display, '', 'el texto no volvió a aparecer');
  assert.equal(box.querySelector('input,select,textarea'), null, 'quedó el casillero abierto');
});

test('Enter guarda en el de un renglón, y NO en el de varios', async () => {
  // En el de varias líneas Enter es un renglón nuevo: guardar ahí haría
  // imposible escribir una nota de dos párrafos.
  const corto = entorno({ ok: true, contacto: {} });
  let c = campoMontado(corto, 'persona', 12, 'cargo', 'Dueño');
  corto.ctCmpEditar(c.cv);
  let inp = c.box.querySelector('input,select,textarea');
  inp.value = 'Encargado';
  inp.disparar('keydown', { key: 'Enter', preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(corto.ctx.pedidos.length, 1);

  const largo = entorno({ ok: true, contacto: {} });
  c = campoMontado(largo, 'persona', 12, 'notas', 'hola', { tipo: 'textarea' });
  largo.ctCmpEditar(c.cv);
  inp = c.box.querySelector('input,select,textarea');
  inp.value = 'hola\nchau';
  inp.disparar('keydown', { key: 'Enter', preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(largo.ctx.pedidos, [], 'Enter guardó una nota a medio escribir');
  // Pero Ctrl+Enter sí.
  inp.disparar('keydown', { key: 'Enter', ctrlKey: true, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(largo.ctx.pedidos.length, 1);
});

// ── CUANDO FALLA ──────────────────────────────────────────────────────────
test('SI FALLA, VUELVE EL VALOR VIEJO Y LO DICE', async () => {
  // Volver atrás sin decir nada se lee como «no se guardó porque sí», y el que
  // acaba de tipear media nota no se entera de que la perdió.
  const e = entorno(new Error('ya hay otra empresa llamada «Giglio»'));
  const { box, cv } = campoMontado(e, 'empresa', 4, 'nombre', 'LA POSTA');
  e.ctCmpEditar(cv);
  const inp = box.querySelector('input,select,textarea');
  inp.value = 'GIGLIO';
  inp.disparar('blur');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(cv.dataset.v, 'LA POSTA', 'se quedó con el valor que no entró');
  assert.ok(!cv.classList.contains('ct-guardando'), 'quedó en gris para siempre');
  const aviso = box.children.find((c) => c.classList.contains('ct-cmp-err'));
  assert.ok(aviso, 'no apareció ningún aviso');
  assert.match(aviso.textContent, /Giglio/);
});

// ── LO QUE REPINTA Y LO QUE NO ────────────────────────────────────────────
test('UN CAMPO CUALQUIERA NO REPINTA LA FICHA', async () => {
  // Repintar en cada blur le destruye el casillero al que ya hizo clic en el
  // campo siguiente, y la ficha salta mientras se la está usando.
  const e = entorno({ ok: true, contacto: { id: 12 } });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').value = 'Encargado';
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.ctx.repintado, undefined, 'repintó por un cargo');
  assert.equal(cv.textContent, 'Encargado', 'no se actualizó el texto a la vista');
  assert.equal(cv.dataset.v, 'Encargado');
});

test('pero el NOMBRE sí: está en el título, en la lista y en las fichas de los demás', async () => {
  const e = entorno({ ok: true, contacto: { id: 12, nombre: 'Juan C. Giglio' } });
  const { box, cv } = campoMontado(e, 'persona', 12, 'nombre', 'Juan Giglio');
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').value = 'Juan C. Giglio';
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(e.ctx.repintado >= 1, 'cambió el nombre y la ficha siguió mostrando el viejo');
});

test('y la lista de atrás se refresca siempre, que es lo que se ve al cerrar', async () => {
  const e = entorno({ ok: true, contacto: { id: 12 } });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño');
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').value = 'Encargado';
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.ctx.recargado, 1);
});

// ── Y QUE EL VALOR VACÍO VUELVA A VERSE COMO VACÍO ────────────────────────
test('borrar un campo lo deja mostrando su texto en gris, no un hueco', async () => {
  const e = entorno({ ok: true, contacto: { id: 12 } });
  const { box, cv } = campoMontado(e, 'persona', 12, 'cargo', 'Dueño', { vacio: 'sin cargo' });
  e.ctCmpEditar(cv);
  box.querySelector('input,select,textarea').value = '';
  box.querySelector('input,select,textarea').disparar('blur');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cv.textContent, 'sin cargo');
  assert.ok(cv.classList.contains('ct-cv-vacio'));
});
