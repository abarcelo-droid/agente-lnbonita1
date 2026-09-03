// ══════════════════════════════════════════════════════════════════════════
// EL BUSCADOR ⌘K NO OFRECE MÓDULOS DE OTRA EMPRESA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 3/9/2026: «veo Proveedores en Contabilidad... pero Contabilidad no
// existe, se llama Contabilidad SG... ¿no será de otra empresa?».
//
// Era de otra empresa. El grupo «Contabilidad» (adm-proveedores, adm-asientos,
// adm-modelos, adm-plan-cuentas, adm-cc-proveedores) es de la sociedad Familia;
// San Gerónimo tiene su propio grupo, «Contabilidad SG». El menú lo escondía
// bien —renderGrupos, renderFavoritos y renderRecientes pasan todos por
// shouldShow— y el buscador leía MODULO_INDEX crudo, que trae los módulos de las
// CUATRO empresas.
//
// Estos tests CORREN renderCmdK de verdad, sacándolo del archivo: verificar el
// texto del filtro no probaría que el filtro se aplica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');

// ── Sacar una función del archivo, entera ─────────────────────────────────
function fn(nombre) {
  const i = SIDEBAR.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no se encontró function ' + nombre);
  const fin = SIDEBAR.indexOf('\r\n}', i);
  assert.ok(fin > i, 'no se encontró el fin de ' + nombre);
  return SIDEBAR.slice(i, fin + 3);
}

// ── El DOM de mentira: sólo lo que renderCmdK toca ────────────────────────
function armarBuscador({ modulos, sociedad, favoritos = [], recientes = [] }) {
  const lista = {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelectorAll() {
      return [...this._html.matchAll(/data-go="([^"]*)"/g)]
        .map(m => ({ modulo: m[1], classList: { add() {} } }));
    },
  };
  const INDEX = {};
  for (const m of modulos) INDEX[m.modulo] = m;

  const codigo = `
    let MODULO_INDEX = __INDEX, CURRENT_SOCIEDAD = __SOC;
    let FAVORITOS = __FAV, RECIENTES = __REC;
    let cmdkResults = [], cmdkActive = 0;
    const document = { getElementById: () => __LISTA };
    // El autoelevador es un SVG dibujado a mano: acá no se mira el icono.
    const ICO_AUTOELEVADOR = '';
    ${fn('shouldShow')}
    ${fn('stripIconFromLabel')}
    ${fn('escapeHtml')}
    ${fn('moduleIcon')}
    ${fn('cmdkItemHTML')}
    ${fn('renderCmdK')}
    return { renderCmdK, lista: __LISTA };
  `;
  const f = new Function('__INDEX', '__SOC', '__FAV', '__REC', '__LISTA', codigo);
  const api = f(INDEX, sociedad, favoritos, recientes, lista);
  // Qué módulos ofreció el buscador para una búsqueda dada.
  api.ofrece = (q) => {
    api.renderCmdK(q);
    return api.lista.querySelectorAll().map(x => x.modulo);
  };
  return api;
}

// Las cuatro empresas del sistema, con el caso que Pablo vio: dos grupos que se
// llaman casi igual y son de empresas distintas.
const SG = 1, FAM = 2;
const MODULOS = [
  { modulo: 'mejoras',         label: '💡 Proponer una mejora', grupo: 'Mejoras',         sociedad_id: null },
  { modulo: 'sg-ct-asientos',  label: 'Asientos SG',            grupo: 'Contabilidad SG', sociedad_id: SG },
  { modulo: 'sg-proveedores',  label: 'Proveedores',            grupo: 'Comercial',       sociedad_id: SG },
  { modulo: 'adm-proveedores', label: 'Proveedores',            grupo: 'Contabilidad',    sociedad_id: FAM },
  { modulo: 'adm-modelos',     label: 'Modelos',                grupo: 'Contabilidad',    sociedad_id: FAM },
];

test('parado en San Gerónimo, el buscador no ofrece la Contabilidad de Familia', () => {
  const b = armarBuscador({ modulos: MODULOS, sociedad: SG });
  const r = b.ofrece('proveedores');
  assert.deepEqual(r, ['sg-proveedores'],
    'el buscador ofreció el Proveedores de la otra empresa');
});

test('y tampoco por el nombre del grupo ajeno', () => {
  // Escribir «contabilidad» es exactamente lo que hizo Pablo.
  const b = armarBuscador({ modulos: MODULOS, sociedad: SG });
  const r = b.ofrece('contabilidad');
  assert.deepEqual(r, ['sg-ct-asientos']);
  assert.ok(!r.includes('adm-modelos'), 'se coló un módulo de Familia');
});

test('parado en Familia sí aparece la suya, y no la de San Gerónimo', () => {
  // El filtro tiene que cortar para los dos lados: si sólo escondiera lo de
  // Familia sería una lista negra, no una regla.
  const b = armarBuscador({ modulos: MODULOS, sociedad: FAM });
  const r = b.ofrece('proveedores');
  assert.deepEqual(r, ['adm-proveedores']);
  assert.deepEqual(b.ofrece('asientos'), []);
});

test('la lista vacía (sin escribir nada) tampoco filtra lo ajeno', () => {
  // Son tres listas distintas —favoritos, recientes y sugeridos— y cada una
  // sale de MODULO_INDEX por su lado. Que una filtre no dice nada de las otras.
  const b = armarBuscador({
    modulos: MODULOS, sociedad: SG,
    favoritos: ['adm-proveedores', 'sg-proveedores'],
    recientes: ['adm-modelos', 'sg-ct-asientos'],
  });
  const r = b.ofrece('');
  assert.deepEqual(r, ['sg-proveedores', 'sg-ct-asientos'],
    'favoritos o recientes dejaron pasar un módulo de otra empresa');
});

test('los sugeridos —cuando no hay favoritos ni recientes— también', () => {
  const b = armarBuscador({ modulos: MODULOS, sociedad: SG });
  const r = b.ofrece('');
  assert.ok(r.length, 'no sugirió nada');
  assert.ok(!r.some(m => m.startsWith('adm-')),
    'los sugeridos ofrecieron módulos de Familia');
});

test('Mejoras se sigue viendo desde las cuatro empresas', () => {
  // Es el buzón de sugerencias: no es de ninguna empresa (sociedad_id null) y
  // tiene que verlo todo el mundo. Un filtro por empresa mal escrito lo borra.
  for (const soc of [SG, FAM]) {
    const b = armarBuscador({ modulos: MODULOS, sociedad: soc });
    assert.ok(b.ofrece('mejora').includes('mejoras'),
      'Mejoras desapareció del buscador en la sociedad ' + soc);
  }
});

test('mientras todavía no se sabe la empresa, no se esconde nada', () => {
  // El primer instante de la carga: CURRENT_SOCIEDAD es null. Filtrar ahí
  // dejaría el buscador vacío hasta que conteste /api/org/sociedades.
  const b = armarBuscador({ modulos: MODULOS, sociedad: null });
  assert.equal(b.ofrece('proveedores').length, 2);
});

test('el menú y el buscador usan la MISMA regla, no dos parecidas', () => {
  // Si mañana cambia el criterio de empresa, tiene que cambiar en un solo lugar.
  const i = SIDEBAR.indexOf('function renderCmdK(');
  const cuerpo = SIDEBAR.slice(i, SIDEBAR.indexOf('\r\n}', i));
  assert.match(cuerpo, /Object\.values\(MODULO_INDEX\)\.filter\(m => shouldShow\(m\)\)/);
  assert.equal((cuerpo.match(/shouldShow\(m\)/g) || []).length, 3,
    'las tres listas del buscador (búsqueda, favoritos, recientes) tienen que filtrar');
});
