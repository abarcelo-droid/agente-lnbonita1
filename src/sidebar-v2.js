/* src/sidebar-v2.js
 * ───────────────────────────────────────────────────────────────
 * Sidebar dinámico v2 para LNB Panel.
 *
 * Reemplaza al <nav> viejo del panel.html sin tocarlo (lo esconde).
 * Lee módulos visibles de /api/org/sidebar y favoritos del usuario
 * desde /api/usuario/favoritos. Recientes y modo compacto se guardan
 * en localStorage.
 *
 * Compatible con:
 *   - window.navTo(modulo)     ← función existente en panel.html para cambiar de sección
 *   - window.doLogout()        ← cerrar sesión
 *   - window.abrirCambiarPassword()
 *   - window.paIrAClima()      ← widget del clima
 *
 * Si alguna no existe, el sidebar muestra un alert como fallback.
 * ─────────────────────────────────────────────────────────────── */

(function(){
'use strict';

const LS_RECIENTES = 'lnb-recientes';
const LS_DENSITY   = 'lnb-sidebar-density';
const LS_COLLAPSED = 'lnb-sidebar-collapsed-groups';
const LS_SOCIEDAD  = 'lnb-sidebar-sociedad';
const MAX_RECIENTES = 4;

// ── QUÉ VERSIÓN ESTÁS VIENDO ──────────────────────────────────────────────
// El número del último cambio mergeado (el número del PR). Se muestra abajo, al
// lado del usuario.
//
// Para qué: mirando una pantalla no hay forma de saber si el arreglo que se
// acaba de mergear ya está o todavía estás viendo la página vieja del navegador.
// Media hora de "no funciona" que en realidad era un Ctrl+F5.
//
// SE ACTUALIZA A MANO, en el mismo cambio que se mergea. Sacarlo de git en el
// arranque sonaba mejor, pero Railway despliega desde una copia sin historial:
// diría siempre lo mismo y mentiría, que es peor que no estar.
const VERSION = 'V1010';

let SIDEBAR_DATA = { grupos: [], modulos: [] };
let SOCIEDADES = [];                             // array de {id, nombre, funcion}
// SIEMPRE hay una empresa elegida. La opción "Todas" se sacó: con ella el menú
// mostraba los ítems de las cuatro y no se sabía sobre qué datos trabajaba cada
// pantalla. Arranca en null sólo hasta que fetchSidebarData elige una.
let CURRENT_SOCIEDAD = null;                     // sociedad_id (number), nunca 'all'
let FAVORITOS = [];
let RECIENTES = [];
let MODULO_INDEX = {};

// ═══════════ Util ═══════════
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function readUserCookie(){
  try {
    const raw = document.cookie.split('; ').find(r => r.startsWith('lnb_user='));
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw.split('=').slice(1).join('=')));
  } catch(_) { return null; }
}

function userInitials(user){
  if (!user) return 'LN';
  const n = (user.nombre || user.username || '').trim();
  const parts = n.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase() || 'LN';
}

function getCollapsedGroups(){
  try { return JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]'); }
  catch(_) { return []; }
}
function setCollapsedGroups(arr){
  localStorage.setItem(LS_COLLAPSED, JSON.stringify(arr));
}
function getRecientes(){
  try { return JSON.parse(localStorage.getItem(LS_RECIENTES) || '[]'); }
  catch(_) { return []; }
}
function pushReciente(modulo){
  // Mejoras no es un módulo del menú: no está en MODULO_INDEX, así que
  // renderRecientes lo descarta igual — pero antes le come uno de los cuatro
  // lugares a un módulo de verdad. Ya está fijo arriba de todo: no necesita atajo.
  if (modulo === 'mejoras') return;
  let r = getRecientes().filter(m => m !== modulo);
  r.unshift(modulo);
  r = r.slice(0, MAX_RECIENTES);
  localStorage.setItem(LS_RECIENTES, JSON.stringify(r));
  RECIENTES = r;
  renderRecientes();
}

// ═══════════ Data fetch ═══════════
async function fetchSidebarData(){
  const [sidebarResp, favsResp, socResp] = await Promise.allSettled([
    fetch('/api/org/sidebar',       { credentials: 'same-origin' }).then(r => r.json()),
    fetch('/api/usuario/favoritos', { credentials: 'same-origin' }).then(r => r.json()),
    fetch('/api/org/sociedades',    { credentials: 'same-origin' }).then(r => r.json()),
  ]);

  if (sidebarResp.status !== 'fulfilled' || !sidebarResp.value?.ok){
    console.error('[SB2] No se pudo cargar /api/org/sidebar', sidebarResp.value || sidebarResp.reason);
    return false;
  }
  SIDEBAR_DATA = sidebarResp.value;

  // ── MEJORAS, ARRIBA DE TODO ─────────────────────────────────────────────
  //
  // Pablo, 2/9/2026: «fuera de todos los menú, como un menú aparte ARRIBA de
  // donde dice COMERCIAL».
  //
  // Va como un GRUPO más, el primero, y no como un bloque escrito a mano en el
  // template: así lo dibuja renderGrupos con niHTML, que es el único camino que
  // dibuja bien un ítem del menú. Escrito a mano quedaba una barrita de color
  // sin contenido, y encima no aparecía en el buscador ⌘K —que se arma con
  // MODULO_INDEX— así que escribir «mejoras» contestaba «sin resultados».
  //
  // Y NO sale de modulos_config a propósito: ahí un módulo se ve sólo si el
  // administrador se lo tildó a cada uno, y este buzón tiene que verlo todo el
  // mundo. `sociedad_id: null` lo hace transversal a las cuatro empresas.
  const MEJORAS = {
    modulo: 'mejoras', label: '💡 Proponer una mejora', grupo: 'Mejoras',
    sociedad_id: null, area_id: null, tipo: 'panel', orden: 0,
    // Sin estrella: favoritos valida contra modulos_config y este módulo no está
    // ahí, así que el botón contestaría 404. Ya está fijo arriba de todo.
    sintetico: true,
  };
  SIDEBAR_DATA.grupos = [{ grupo: 'Mejoras', items: [MEJORAS] }]
    .concat(SIDEBAR_DATA.grupos || []);

  // Index global por modulo
  MODULO_INDEX = {};
  for (const g of SIDEBAR_DATA.grupos){
    for (const m of g.items){
      MODULO_INDEX[m.modulo] = m;
    }
  }

  FAVORITOS = (favsResp.status === 'fulfilled' && favsResp.value?.ok)
    ? favsResp.value.favoritos.map(f => f.modulo)
    : [];

  SOCIEDADES = (socResp.status === 'fulfilled' && socResp.value?.ok)
    ? socResp.value.sociedades
    : [];

  // ── SIEMPRE UNA EMPRESA ELEGIDA ──────────────────────────────────────
  // Se restaura la última, y si no hay ninguna guardada —o la guardada ya no
  // existe, o decía 'all' de antes— se elige la primera. Dejarlo sin elegir
  // sería volver a "Todas" con otro nombre: el menú no sabría qué mostrar y las
  // llamadas al servidor irían sin empresa.
  const saved = localStorage.getItem(LS_SOCIEDAD);
  const id = saved && saved !== 'all' ? parseInt(saved, 10) : NaN;
  if (!isNaN(id) && SOCIEDADES.some(s => s.id === id)){
    CURRENT_SOCIEDAD = id;
  } else if (SOCIEDADES.length){
    CURRENT_SOCIEDAD = SOCIEDADES[0].id;
    localStorage.setItem(LS_SOCIEDAD, String(CURRENT_SOCIEDAD));
  }

  RECIENTES = getRecientes().filter(m => MODULO_INDEX[m]);
  return true;
}

// Helper: ¿este módulo debe mostrarse según el filtro actual de sociedad?
function shouldShow(m){
  // Sin empresa elegida todavía (el primer instante de la carga) no se filtra:
  // si no, el menú parpadearía vacío.
  if (CURRENT_SOCIEDAD === null) return true;
  // Un módulo sin empresa se ve desde todas. No debería quedar ninguno —
  // ensure_modulo_empresas.js los asigna y avisa por consola si sobra alguno—
  // pero si aparece uno nuevo es mejor que se vea a que desaparezca sin rastro.
  if (!m.sociedad_id) return true;
  return m.sociedad_id === CURRENT_SOCIEDAD;
}

// ═══════════ Render principal ═══════════
function buildSidebar(){
  // Esconder el nav viejo
  const oldNav = document.querySelector('body > .shell > nav, .shell > nav');
  if (oldNav) oldNav.style.display = 'none';

  // Crear el nuevo
  const sb = document.createElement('aside');
  sb.className = 'sb2';
  sb.id = 'sidebar-v2';
  sb.setAttribute('data-density', localStorage.getItem(LS_DENSITY) || 'comfortable');

  const user = readUserCookie();
  const initials = userInitials(user);
  const userName = (user?.nombre || user?.username || 'Usuario');
  const userRole = (user?.rol || '').toUpperCase();

  sb.innerHTML = `
    <!-- Brand -->
    <div class="sb2-brand">
      <div class="sb2-brand-text">
        <div class="sb2-brand-name" id="sb2-brand-name">La Niña Bonita</div>
        <div class="sb2-brand-sub" id="sb2-brand-sub">Sistema de gestión</div>
      </div>
      <div class="sb2-avatar" title="${escapeHtml(userName)}${userRole ? ' · ' + escapeHtml(userRole) : ''}" data-action="user-menu">
        ${escapeHtml(initials)}
        <span class="sb2-av-pip" title="En línea"></span>
      </div>
    </div>

    <!-- Búsqueda -->
    <div class="sb2-search" data-action="cmdk">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <span class="sb2-search-text">Buscar</span>
      <span class="sb2-kbd">⌘K</span>
    </div>

    <!-- Selector de sociedad -->
    <div class="sb2-soc" id="sb2-soc"></div>

    <!-- Widget Hoy -->
    <div class="sb2-hoy" data-action="hoy">
      <div class="sb2-hoy-icon" id="sb2-hoy-icon">🌤️</div>
      <div class="sb2-hoy-meta">
        <div class="sb2-hoy-temp" id="sb2-hoy-temp">—°</div>
        <div class="sb2-hoy-sub" id="sb2-hoy-sub">Carpintería</div>
      </div>
    </div>

    <!-- Toggle compacto -->
    <button class="sb2-density-toggle" data-action="density" title="Colapsar / expandir sidebar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m15 18-6-6 6-6"/></svg>
    </button>

    <!-- Favoritos -->
    <div id="sb2-favoritos-wrap"></div>

    <!-- Recientes -->
    <div id="sb2-recientes-wrap"></div>

    <!-- Divider fuerte entre fast lanes y menú normal -->
    <div class="sb2-divider"></div>
    <div class="sb2-group-sec"><span class="sb2-label">Menú completo</span></div>

    <!-- Grupos -->
    <div id="sb2-grupos"></div>

    <!-- LNB APP (removido por pedido) -->

    <!-- User bar -->
    <div class="sb2-user">
      <div class="sb2-user-meta">
        <div class="sb2-user-name">${escapeHtml(userName)}</div>
        <div class="sb2-user-role">${escapeHtml(userRole || 'Operador')}
          <span class="sb2-version" title="Versión desplegada — es el número del último cambio que se mergeó">${VERSION}</span>
        </div>
      </div>
      <button class="sb2-user-cog" data-action="cog" title="Cambiar contraseña / Cerrar sesión">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  `;

  // Insertar al inicio del .shell (antes que main)
  const shell = document.querySelector('.shell') || document.body;
  shell.insertBefore(sb, shell.firstChild);

  // Cmd+K palette container (en body, no en sidebar)
  const cmdk = document.createElement('div');
  cmdk.className = 'sb2-cmdk-back';
  cmdk.id = 'sb2-cmdk-back';
  cmdk.innerHTML = `
    <div class="sb2-cmdk" role="dialog">
      <div class="sb2-cmdk-input-row">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="sb2-cmdk-input" id="sb2-cmdk-input" placeholder="Buscar sección…" autocomplete="off">
      </div>
      <div class="sb2-cmdk-list" id="sb2-cmdk-list"></div>
    </div>
  `;
  document.body.appendChild(cmdk);

  renderSocSelector();
  renderFavoritos();
  renderRecientes();
  renderGrupos();
  attachEventListeners();
  hookCurrentSection();
  fetchClima();
}

// ═══════════ Render: Selector de Sociedad ═══════════
// Mapeo nombre/función -> color semántico del trigger
function sociedadColor(sociedad){
  if (!sociedad) return 'todas';
  const nombre = (sociedad.nombre || '').toLowerCase();
  // Los dos primeros salen del logo de la casa: el bordó del lettering y el ocre
  // del medallón. Que el color sea el de la marca y no uno inventado es lo que
  // hace que se reconozca sin tener que leer el nombre.
  if (nombre.includes('san gerónimo') || nombre.includes('san geronimo')) return 'ocre';
  if (nombre.includes('puente cordón')   || nombre.includes('puente cordon')) return 'bordo';
  if (nombre.includes('barceló transporte') || nombre.includes('barcelo transporte')) return 'azul';
  if (nombre.includes('familia')) return 'carbon';
  // Fallback por función si el nombre no matchea exactamente
  if (sociedad.funcion === 'productiva')  return 'bordo';
  if (sociedad.funcion === 'comercial')   return 'ocre';
  if (sociedad.funcion === 'transporte')  return 'azul';
  if (sociedad.funcion === 'estructura')  return 'carbon';
  return 'todas';
}

function renderSocSelector(){
  const wrap = document.getElementById('sb2-soc');
  if (!wrap || !SOCIEDADES.length){
    if (wrap) wrap.innerHTML = '';
    return;
  }

  const activeSoc = SOCIEDADES.find(s => s.id === CURRENT_SOCIEDAD) || SOCIEDADES[0];
  const currentLabel = activeSoc ? activeSoc.nombre : '—';
  const currentColor = activeSoc ? sociedadColor(activeSoc) : 'todas';

  // El color pinta el MENÚ COMPLETO y el título dice la empresa. Antes el color
  // llegaba sólo al botón del selector: había que buscarlo para saber dónde se
  // estaba parado, y con tres empresas que comparten pantallas eso se pasa por alto.
  const sb2 = document.querySelector('.sb2');
  if (sb2) sb2.setAttribute('data-soc-color', currentColor);
  const bn = document.getElementById('sb2-brand-name');
  const bs = document.getElementById('sb2-brand-sub');
  if (bn && bs) {
    bn.textContent = activeSoc ? activeSoc.nombre.replace(/\s+(SA|SRL|S\.A\.|S\.R\.L\.)$/i, '') : 'La Niña Bonita';
    bs.textContent = 'Sistema de gestión';
  }

  const FUNC_LABELS = {
    'productiva':  'Producción',
    'comercial':   'Comercial',
    'transporte':  'Transporte',
    'estructura':  'Familia',
  };
  const byFunc = {};
  for (const s of SOCIEDADES){
    const k = s.funcion || 'otra';
    if (!byFunc[k]) byFunc[k] = [];
    byFunc[k].push(s);
  }

  // Sin opción "Todas": el selector manda sobre qué empresa y qué tablas se
  // trabaja, así que tiene que decir una.
  let menuHTML = '';
  const ordenFunc = ['productiva','comercial','transporte','estructura','otra'];
  for (const k of ordenFunc){
    if (!byFunc[k]) continue;
    // (Sin divider — los dots de color ya identifican el tipo)
    for (const s of byFunc[k]){
      const isActive = s.id === CURRENT_SOCIEDAD;
      const col = sociedadColor(s);
      menuHTML += `
        <div class="sb2-soc-item ${isActive ? 'active' : ''}" data-soc="${s.id}" data-soc-color="${col}">
          <span class="check"></span>
          <span>${escapeHtml(s.nombre)}</span>
          <span class="soc-dot"></span>
        </div>
      `;
    }
  }

  wrap.innerHTML = `
    <button class="sb2-soc-trigger" data-action="toggle-soc" data-soc-color="${currentColor}">
      <span class="soc-ico">🏢</span>
      <span class="soc-label">${escapeHtml(currentLabel)}</span>
      <span class="soc-caret">▾</span>
    </button>
    <div class="sb2-soc-menu">${menuHTML}</div>
  `;
}

function toggleSocMenu(){
  const trig = document.querySelector('.sb2-soc-trigger');
  if (trig) trig.classList.toggle('open');
}

function closeSocMenu(){
  const trig = document.querySelector('.sb2-soc-trigger');
  if (trig) trig.classList.remove('open');
}

function selectSociedad(value){
  const prev = localStorage.getItem(LS_SOCIEDAD) || '';
  const id = parseInt(value, 10);
  if (isNaN(id)) return;          // 'all' ya no existe: se ignora
  const nuevo = String(id);
  CURRENT_SOCIEDAD = id;
  localStorage.setItem(LS_SOCIEDAD, nuevo);
  closeSocMenu();
  // Cambio real de sociedad = cambio de contexto de datos. Recarga limpia para que
  // todos los módulos (y sus caches) relean con el nuevo sociedad_id. Multisociedad F1/F2/F3.
  if (nuevo !== prev){ location.reload(); return; }
  renderSocSelector();
  renderFavoritos();
  renderRecientes();
  renderGrupos();
}

// ═══════════ Render: Favoritos ═══════════
function renderFavoritos(){
  const wrap = document.getElementById('sb2-favoritos-wrap');
  if (!wrap) return;
  const favs = FAVORITOS.map(m => MODULO_INDEX[m]).filter(m => m && shouldShow(m));
  if (!favs.length){
    wrap.innerHTML = `
      <div class="sb2-fastlane fav">
        <div class="sb2-group-sec">
          <span class="sb2-label">⭐ Favoritos</span>
        </div>
        <div class="sb2-empty-fav">
          <span class="star-pulse">★</span>
          <span>${FAVORITOS.length ? 'No hay favoritos en esta empresa. Marcá con ★ los que uses seguido.' : 'Marcá tus secciones más usadas con la estrella para acceso rápido desde acá.'}</span>
        </div>
      </div>
    `;
    return;
  }
  wrap.innerHTML = `
    <div class="sb2-fastlane fav">
      <div class="sb2-group-sec">
        <span class="sb2-label">⭐ Favoritos</span>
        <span class="badge-count">${favs.length}</span>
      </div>
      ${favs.map(m => niHTML(m, true)).join('')}
    </div>
  `;
}

// ═══════════ Render: Recientes ═══════════
function renderRecientes(){
  const wrap = document.getElementById('sb2-recientes-wrap');
  if (!wrap) return;
  const recientesFiltrados = RECIENTES
    .filter(m => !FAVORITOS.includes(m))
    .map(m => MODULO_INDEX[m])
    .filter(m => m && shouldShow(m));
  if (!recientesFiltrados.length){ wrap.innerHTML = ''; return; }

  wrap.innerHTML = `
    <div class="sb2-fastlane rec">
      <div class="sb2-group-sec">
        <span class="sb2-label">⏱ Recientes</span>
        <span class="badge-count">${recientesFiltrados.length}</span>
      </div>
      ${recientesFiltrados.map(m => niHTML(m, false)).join('')}
    </div>
  `;
}

// ═══════════ Render: Grupos ═══════════
function renderGrupos(){
  const wrap = document.getElementById('sb2-grupos');
  if (!wrap) return;
  const collapsed = getCollapsedGroups();

  const gruposFiltrados = SIDEBAR_DATA.grupos
    .map(g => ({ ...g, items: g.items.filter(shouldShow) }))
    .filter(g => g.items.length > 0);

  // EL MENÚ VACÍO SE MIDE SIN LO SINTÉTICO. Mejoras está siempre —lo ve todo el
  // mundo—, así que contándolo el menú nunca queda "vacío" y el aviso de "todavía
  // no tenés accesos asignados" no se mostraría nunca más. Ese aviso es la única
  // forma que tiene alguien recién dado de alta de entender qué le falta.
  const conAccesos = gruposFiltrados
    .some(g => (g.items || []).some(m => !m.sintetico));

  if (!conAccesos){
    // Sin un solo módulo hay dos motivos posibles, y decir el equivocado manda a
    // la persona a buscar donde no es:
    //
    //  · No tiene NINGÚN acceso cargado. Desde que rige "sin permisos no se ve
    //    nada", el menú vacío no es un error: es la respuesta. Pero hay que
    //    decirle qué hacer, o se queda mirando una pantalla en blanco pensando
    //    que el sistema se rompió.
    //  · Tiene accesos, pero ninguno en la empresa que eligió arriba.
    const tieneEnOtra = (SIDEBAR_DATA.grupos || [])
      .some(g => (g.items || []).some(m => !m.sintetico));
    // Mejoras se dibuja igual: es justamente por donde esa persona puede pedir
    // que le den los accesos.
    wrap.innerHTML = gruposHTML(gruposFiltrados, collapsed) + (tieneEnOtra
      ? `<div style="padding:14px 16px;font-size:11.5px;color:rgba(255,255,255,.55);text-align:center;line-height:1.5">
           No tenés accesos en esta empresa.<br>Probá cambiándola arriba.
         </div>`
      : `<div style="padding:18px 16px;font-size:12px;color:rgba(255,255,255,.75);text-align:center;line-height:1.6">
           <div style="font-size:22px;margin-bottom:6px">🔑</div>
           <b>Todavía no tenés accesos asignados.</b><br>
           <span style="color:rgba(255,255,255,.55)">Pedile a un administrador que te dé permiso a los módulos que necesitás.</span>
         </div>`);
    return;
  }

  wrap.innerHTML = gruposHTML(gruposFiltrados, collapsed);
}

// El HTML de los grupos, en un solo lugar: lo usan el menú normal y el aviso de
// "todavía no tenés accesos", que ahora también dibuja el grupo de Mejoras.
function gruposHTML(grupos, collapsed){
  return grupos.map(g => {
    const isCollapsed = collapsed.includes(g.grupo);
    return `
      <div class="sb2-grp ${isCollapsed ? 'collapsed' : ''}" data-grp="${escapeHtml(g.grupo)}">
        <div class="sb2-grp-text">
          <span class="sb2-grp-ico">${groupIcon(g.grupo)}</span>
          <span>${escapeHtml(g.grupo)}</span>
        </div>
        <span class="sb2-grp-caret">▾</span>
      </div>
      <div class="sb2-grp-items">
        ${g.items.map(m => niHTML(m, false)).join('')}
      </div>
    `;
  }).join('');
}

function niHTML(m, isFavSection){
  // Los ítems sintéticos —los que no viven en modulos_config— no pueden ser
  // favoritos: la ruta de favoritos valida contra esa tabla y contestaría 404.
  if (m.sintetico){
    return `
      <a class="sb2-ni" data-sec="${escapeHtml(m.modulo)}" href="#">
        <span class="sb2-ni-ico">${moduleIcon(m)}</span>
        <span class="sb2-ni-text">${escapeHtml(stripIconFromLabel(m.label))}</span>
      </a>
    `;
  }
  const isFav = FAVORITOS.includes(m.modulo);
  const starClass = isFav ? 'sb2-star on' : 'sb2-star';
  const starTitle = isFav ? 'Quitar de favoritos' : 'Agregar a favoritos';
  // En la sección favoritos no mostramos el botón duplicado
  const star = isFavSection
    ? `<span class="${starClass}" data-fav="${escapeHtml(m.modulo)}" title="${starTitle}">★</span>`
    : `<span class="${starClass}" data-fav="${escapeHtml(m.modulo)}" title="${starTitle}">★</span>`;
  return `
    <a class="sb2-ni" data-sec="${escapeHtml(m.modulo)}" href="#">
      <span class="sb2-ni-ico">${moduleIcon(m)}</span>
      <span class="sb2-ni-text">${escapeHtml(stripIconFromLabel(m.label))}</span>
      ${star}
    </a>
  `;
}

// Algunos labels del seed traen emoji al inicio ("🌤️ Clima"); lo separamos para no duplicar
function stripIconFromLabel(label){
  if (!label) return '';
  // Quita emoji y espacio inicial si está
  return label.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*/u, '');
}

// El autoelevador de Control Cooperativa. Va como SVG y no como emoji porque
// autoelevador NO EXISTE en Unicode: lo más cercano es un tractor, que no es lo
// que hace una cooperativa en el galpón. Dibujado con el mismo trazo que el
// resto del sidebar (currentColor + stroke 2), así que se pinta solo cuando el
// ítem está activo, cosa que un emoji no hace.
const ICO_AUTOELEVADOR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
  + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 17v-5h5l2-4h3v9"/>'   // la cabina, con el parabrisas inclinado
  + '<circle cx="6" cy="19" r="2"/><circle cx="13" cy="19" r="2"/>'
  + '<path d="M17 20V4"/>'             // el mástil
  + '<path d="M17 5h3"/>'              // el respaldo de carga, arriba
  + '<path d="M17 17h4"/>'             // la uña, a la altura del piso
  + '</svg>';

function moduleIcon(m){
  // 1) Mapping manual prioritario — emojis por módulo según el panel original
  const map = {
    // El buzón de mejoras: no es una pantalla de trabajo, es donde se pide algo.
    'mejoras':           '✍️',
    // General / Sistema
    'inicio':            '⌂',
    'calendario':        '📅',
    'conv':              '💬',
    'equipo':            '🏢',
    'maestro-usuarios':  '👥',
    'ingreso-factura':   '🧾',
    // Comercial
    'crm':               '💼',
    'dedicados':         '⭐',
    'food':              '🍴',
    'may-a':             '🏪',
    'may-mcba':          '🏪',
    'min-mcba':          '🛒',
    'min-ent':           '🚚',
    'cons-final':        '👤',
    'pedidos':           '📋',
    'repet':             '🔁',
    // Pricing / Oferta
    'pricing1':          '💲',
    'pricing2':          '💲',
    'oferta1':           '🏷️',
    'oferta2':           '🏷️',
    // Logística
    'logistica':         '🚛',
    'envios':            '📨',
    'preparacion':       '📦',
    'remitos':           '📋',
    'guardias':          '🕐',
    // Cobranzas
    'cobranza':          '💰',
    'cta-cte':           '💳',
    // Producción Agrícola
    'pa-dashboard':      '🌱',
    'pa-lotes':          '🌾',
    'pa-insumos':        '🧪',
    'pa-clima':          '🌤️',
    'pa-combustible':    '⛽',
    'pa-compras':        '🛒',
    'pa-costos':         '💲',
    'pa-cuentas':        '📊',
    'pa-calendario':     '📅',
    'pa-despachos':      '🚚',
    'pa-electricidad':   '⚡',
    'pa-ordenes':        '📋',
    'pa-panol':          '🔧',
    'pa-personal':       '👷',
    'pa-scout':          '📱',
    'pli-planificacion': '📦',
    'sp-pagos':          '💸',
    // San Gerónimo
    'sg-control-coop':   ICO_AUTOELEVADOR,
    // Abasto IFCO
    'ab-dashboard':      '📊',
    'ab-gastos':         '💸',
    'ab-ifcos':          '📦',
    'ab-liquidaciones':  '📄',
    'ab-mandata':        '🧾',
    'ab-partidas':       '🚛',
    'ab-proveedores':    '🏭',
    'ab-remitos':        '📋',
    'ab-stock':          '📦',
    // Contabilidad
    'adm-asientos':      '📒',
    'adm-cc-proveedores':'💳',
    'adm-modelos':       '📐',
    'adm-plan-cuentas':  '📊',
    'adm-proveedores':   '🏭',
    // Financiero
    'fin-caja-bancos':   '🏦',
    'fin-ordenes-pago':  '📄',
    // Ventas
    'ven-clientes':      '👥',
    'ven-facturas':      '🧾',
    'ven-cobranzas':     '💰',
    'ven-cc':            '💳',
    'ven-liquidaciones': '🌾',
    // Retail
    'retail-view':       '🛒',
    'retail-prod':       '🌱',
    'retail-gastos':     '💸',
    'rent-retail':       '📈',
  };
  if (map[m.modulo]) return map[m.modulo];

  // 2) Si el label ya trae emoji al inicio (ej. "🌤️ Clima"), usarlo
  const match = (m.label || '').match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?)/u);
  if (match) return match[1];

  // 3) Fallback por tipo
  const TIPO_ICONS = {
    'numero':    '#',
    'operativo': '•',
    'mobile':    '📱',
    'externo':   '↗',
    'sistema':   '⚙',
  };
  return TIPO_ICONS[m.tipo] || '•';
}

function groupIcon(grupo){
  const ICONS = {
    'General':       '⌂',
    'Sistema':       '⚙',
    'Comercial':     '💼',
    'Pricing':       '$',
    'Logística':     '🚚',
    'Cobranzas':     '💰',
    'Producción':    '🌱',
    'Abasto IFCO':   '📦',
    'Contabilidad':  '📒',
    'Financiero':    '🏦',
    'Ventas':        '🧾',
    'Retail':        '🛒',
    'Mejoras':       '💡',
  };
  return ICONS[grupo] || '·';
}

// ═══════════ Event handlers ═══════════
function attachEventListeners(){
  const sb = document.getElementById('sidebar-v2');
  if (!sb) return;

  // Click delegation
  sb.addEventListener('click', e => {
    // Acciones
    const actionEl = e.target.closest('[data-action]');
    if (actionEl){
      const action = actionEl.dataset.action;
      if (action === 'cmdk')     { e.preventDefault(); openCmdK(); return; }
      if (action === 'density')  { toggleDensity(); return; }
      if (action === 'hoy')      { irAClima(); return; }
      if (action === 'user-menu'){ openUserMenu(); return; }
      if (action === 'cog')      { openUserMenu(); return; }
      if (action === 'toggle-soc'){ e.preventDefault(); e.stopPropagation(); toggleSocMenu(); return; }
    }

    // Item del selector de sociedad
    const socItem = e.target.closest('.sb2-soc-item[data-soc]');
    if (socItem){
      e.preventDefault();
      selectSociedad(socItem.dataset.soc);
      return;
    }

    // Star (favorito)
    const fav = e.target.closest('[data-fav]');
    if (fav){
      e.preventDefault();
      e.stopPropagation();
      toggleFavorito(fav.dataset.fav);
      return;
    }

    // Grupo (collapse)
    const grp = e.target.closest('.sb2-grp');
    if (grp){
      grp.classList.toggle('collapsed');
      const grupo = grp.dataset.grp;
      let collapsed = getCollapsedGroups();
      if (grp.classList.contains('collapsed')){
        if (!collapsed.includes(grupo)) collapsed.push(grupo);
      } else {
        collapsed = collapsed.filter(g => g !== grupo);
      }
      setCollapsedGroups(collapsed);
      return;
    }

    // Click en ítem
    const ni = e.target.closest('.sb2-ni[data-sec]');
    if (ni){
      e.preventDefault();
      navigateTo(ni.dataset.sec);
      return;
    }
  });
}

function navigateTo(modulo){
  pushReciente(modulo);
  // Marcar como activo en el sidebar nuevo
  document.querySelectorAll('.sb2-ni').forEach(n => n.classList.remove('on'));
  document.querySelectorAll('.sb2-ni[data-sec="' + CSS.escape(modulo) + '"]').forEach(n => n.classList.add('on'));

  // Trigger del nav viejo: buscar el .ni con el data-sec correcto y simular click.
  // El nav viejo está escondido (display:none) pero sus event listeners siguen activos —
  // disparamos la navegación real del panel.
  const oldNi = document.querySelector('nav .ni[data-sec="' + CSS.escape(modulo) + '"], #sidebar-old-hidden .ni[data-sec="' + CSS.escape(modulo) + '"]');
  if (oldNi){
    oldNi.click();
    return;
  }

  // Fallback: si por alguna razón no existe el .ni viejo, probamos con el sistema antiguo
  // de mostrar/ocultar .sec directamente
  console.warn('[SB2] No se encontró .ni del nav viejo para "' + modulo + '" — fallback manual');
  document.querySelectorAll('.sec').forEach(s => s.classList.remove('on'));
  const sec = document.getElementById('sec-' + modulo);
  if (sec) sec.classList.add('on');
  window.scrollTo(0, 0);
}

function hookCurrentSection(){
  // ── DÓNDE ABRE EL PANEL ─────────────────────────────────────────────────
  // Los módulos que esta empresa tiene. Es la única lista que vale: el menú ya
  // no muestra lo de las otras.
  const suyos = (SIDEBAR_DATA.grupos || []).flatMap(g => g.items || []).filter(shouldShow);

  // El nav viejo trae "Inicio" marcado como activo en el HTML (panel.html:312).
  // Eso se respetaba SIEMPRE, así que el panel abría en Inicio pase lo que pase
  // — y como Inicio es de San Gerónimo, parado en Puente Cordón o en Barceló se
  // veían los pedidos y el CRM de San Gerónimo con el cartel diciendo otra cosa.
  //
  // Ahora se respeta sólo si ese módulo es DE ESTA EMPRESA. Si no, se ignora.
  const onItem = document.querySelector('nav .ni.on');
  const pedido = onItem && onItem.dataset ? onItem.dataset.sec : null;
  const sirve = pedido && suyos.some(m => m.modulo === pedido);

  if (sirve){ navigateTo(pedido); return; }

  const inicio = suyos.find(m => m.modulo === 'inicio');
  const primero = inicio || suyos[0];
  if (primero){ navigateTo(primero.modulo); return; }

  // Sin un solo módulo no hay dónde ir: se apagan TODAS las secciones para no
  // dejar en pantalla los datos de otra empresa.
  document.querySelectorAll('.sec').forEach(sec => sec.classList.remove('on'));
}

async function toggleFavorito(modulo){
  const wasFav = FAVORITOS.includes(modulo);
  // Optimistic update
  if (wasFav) FAVORITOS = FAVORITOS.filter(m => m !== modulo);
  else        FAVORITOS = [...FAVORITOS, modulo];
  renderFavoritos();
  renderRecientes();
  // También actualizar stars en grupos
  document.querySelectorAll(`[data-fav="${CSS.escape(modulo)}"]`).forEach(s => {
    s.classList.toggle('on', !wasFav);
  });

  try {
    const method = wasFav ? 'DELETE' : 'POST';
    const r = await fetch('/api/usuario/favoritos/' + encodeURIComponent(modulo), {
      method, credentials: 'same-origin'
    });
    const data = await r.json();
    if (!data.ok){
      // Revertir
      if (wasFav) FAVORITOS = [...FAVORITOS, modulo];
      else        FAVORITOS = FAVORITOS.filter(m => m !== modulo);
      renderFavoritos();
      renderRecientes();
      console.error('[SB2] Error toggling favorito:', data.error);
    }
  } catch(e) {
    // Revertir
    if (wasFav) FAVORITOS = [...FAVORITOS, modulo];
    else        FAVORITOS = FAVORITOS.filter(m => m !== modulo);
    renderFavoritos();
    renderRecientes();
    console.error('[SB2] Error de red al toggle favorito:', e);
  }
}

function toggleDensity(){
  const sb = document.getElementById('sidebar-v2');
  const cur = sb.getAttribute('data-density') || 'comfortable';
  const next = cur === 'comfortable' ? 'compact' : 'comfortable';
  sb.setAttribute('data-density', next);
  localStorage.setItem(LS_DENSITY, next);
}

function openUserMenu(){
  // Buscar funciones existentes; si no hay, fallback con confirm
  const items = [];
  if (typeof window.abrirCambiarPassword === 'function')
    items.push({ label: '🔑 Cambiar contraseña', fn: window.abrirCambiarPassword });
  if (typeof window.doLogout === 'function')
    items.push({ label: '🚪 Cerrar sesión', fn: window.doLogout });

  if (!items.length){
    alert('Menú de usuario\n(En este panel no hay funciones de logout disponibles)');
    return;
  }

  // Menú simple via confirm si son 2 acciones; sino primero
  if (items.length === 2){
    const cambiar = confirm('¿Cambiar contraseña? (cancelar = cerrar sesión)');
    if (cambiar) items[0].fn();
    else         items[1].fn();
  } else {
    items[0].fn();
  }
}

function irAClima(){
  if (typeof window.paIrAClima === 'function') window.paIrAClima();
  else if (MODULO_INDEX['pa-clima']) navigateTo('pa-clima');
}

// ═══════════ Clima (proxy a SMN) ═══════════
async function fetchClima(){
  try {
    const r = await fetch('/api/pa/clima/smn', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    if (!json?.ok || !json.data) return;

    const d = json.data;
    const w = d.weather || {};

    // SMN devuelve: temp (°C), humidity (%), wind_speed (km/h), wind_deg, description, ...
    const temp = w.temp ?? w.temperatura;
    const desc = w.description || w.descripcion || '';

    if (temp != null && !isNaN(temp)){
      const el = document.getElementById('sb2-hoy-temp');
      if (el) el.textContent = Math.round(temp) + '°';
    }
    const iconEl = document.getElementById('sb2-hoy-icon');
    if (iconEl) iconEl.textContent = climaEmoji(desc);

    const sub = document.getElementById('sb2-hoy-sub');
    if (sub){
      const ubic = d.estacion || 'Carpintería';
      // Capitalizar descripción y mostrarla bonita
      const descLabel = desc ? (desc.charAt(0).toUpperCase() + desc.slice(1).toLowerCase()) : '';
      let html = escapeHtml(ubic);
      if (descLabel) html += '<span class="sb2-alert" style="color:rgba(255,255,255,.55);font-weight:600">' + escapeHtml(descLabel) + '</span>';
      sub.innerHTML = html;
    }
  } catch(e) {
    console.warn('[SB2] No se pudo cargar el clima:', e.message);
    // Se queda con el placeholder "—° / Carpintería"
  }
}
function climaEmoji(desc){
  const d = (desc || '').toLowerCase();
  if (d.includes('lluv') || d.includes('rain') || d.includes('lluvi'))   return '🌧️';
  if (d.includes('tormenta') || d.includes('storm'))                       return '⛈️';
  if (d.includes('nubl') || d.includes('cloud'))                           return '⛅';
  if (d.includes('parc') || d.includes('algo nub'))                        return '⛅';
  if (d.includes('sol')  || d.includes('clear') || d.includes('despej'))   return '☀️';
  if (d.includes('nieve')|| d.includes('snow'))                            return '❄️';
  if (d.includes('niebla') || d.includes('fog') || d.includes('bruma'))    return '🌫️';
  return '🌤️';
}

// ═══════════ Cmd+K palette ═══════════
let cmdkActive = 0;
let cmdkResults = [];

function openCmdK(){
  const back = document.getElementById('sb2-cmdk-back');
  back.classList.add('on');
  const inp = document.getElementById('sb2-cmdk-input');
  inp.value = '';
  renderCmdK('');
  setTimeout(() => inp.focus(), 20);
}

function closeCmdK(){
  document.getElementById('sb2-cmdk-back')?.classList.remove('on');
}

function renderCmdK(q){
  q = (q || '').toLowerCase().trim();
  const list = document.getElementById('sb2-cmdk-list');

  // EL BUSCADOR MUESTRA LO MISMO QUE EL MENÚ, NI UN ÍTEM MÁS.
  //
  // Pablo, 3/9/2026: «veo Proveedores en Contabilidad... pero Contabilidad no
  // existe, se llama Contabilidad SG... ¿no será de otra empresa?». Era de otra
  // empresa: el grupo «Contabilidad» es de Familia, y San Gerónimo tiene el suyo
  // aparte. El menú lo escondía bien —renderGrupos, favoritos y recientes pasan
  // todos por shouldShow— y sólo el ⌘K leía MODULO_INDEX crudo, que trae los
  // módulos de las CUATRO empresas.
  //
  // Que el router después conteste 403 no arregla lo importante: el buscador ya
  // le dijo qué áreas tiene la otra empresa, y lo mandó a una pantalla que no es
  // la suya a buscar algo que ahí no está. Es la misma regla que ya estaba
  // escrita en rutas/sidebar.js: cada empresa es autónoma, el menú no muestra lo
  // ajeno.
  const allItems = Object.values(MODULO_INDEX).filter(m => shouldShow(m));

  if (!q){
    const favItems    = FAVORITOS.map(m => MODULO_INDEX[m]).filter(m => m && shouldShow(m));
    const recItems    = RECIENTES.filter(m => !FAVORITOS.includes(m)).map(m => MODULO_INDEX[m]).filter(m => m && shouldShow(m));
    const groups = [];
    if (favItems.length) groups.push({ label: '⭐ Favoritos',   items: favItems });
    if (recItems.length) groups.push({ label: '⏱ Recientes',   items: recItems });
    // Si no hay favoritos ni recientes, sugerir los primeros por orden
    if (!groups.length) groups.push({ label: '📁 Sugeridos', items: allItems.slice(0, 8) });

    list.innerHTML = groups.map(g => `
      <div class="sb2-cmdk-group-label">${escapeHtml(g.label)}</div>
      ${g.items.map(cmdkItemHTML).join('')}
    `).join('');
  } else {
    const filtered = allItems.filter(m =>
      (m.label || '').toLowerCase().includes(q) ||
      (m.grupo || '').toLowerCase().includes(q) ||
      (m.sociedad_nombre || '').toLowerCase().includes(q) ||
      m.modulo.toLowerCase().includes(q)
    );
    if (!filtered.length){
      list.innerHTML = `<div class="sb2-cmdk-empty">Sin resultados para "${escapeHtml(q)}"</div>`;
    } else {
      list.innerHTML = filtered.map(cmdkItemHTML).join('');
    }
  }

  cmdkResults = [...list.querySelectorAll('.sb2-cmdk-item')];
  cmdkActive = 0;
  if (cmdkResults[0]) cmdkResults[0].classList.add('active');
}

function cmdkItemHTML(m){
  return `<div class="sb2-cmdk-item" data-go="${escapeHtml(m.modulo)}">
    <span class="sb2-cmdk-ico">${moduleIcon(m)}</span>
    <span>${escapeHtml(stripIconFromLabel(m.label))}</span>
    <span class="sb2-cmdk-path">${escapeHtml(m.grupo || '')}</span>
  </div>`;
}

// Listeners globales para Cmd+K
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
    e.preventDefault();
    const isOpen = document.getElementById('sb2-cmdk-back')?.classList.contains('on');
    if (isOpen) closeCmdK();
    else        openCmdK();
    return;
  }

  const back = document.getElementById('sb2-cmdk-back');
  if (!back?.classList.contains('on')) return;

  if (e.key === 'Escape'){ closeCmdK(); return; }
  if (!cmdkResults.length) return;

  if (e.key === 'ArrowDown'){
    e.preventDefault();
    cmdkResults[cmdkActive].classList.remove('active');
    cmdkActive = (cmdkActive + 1) % cmdkResults.length;
    cmdkResults[cmdkActive].classList.add('active');
    cmdkResults[cmdkActive].scrollIntoView({ block:'nearest' });
  } else if (e.key === 'ArrowUp'){
    e.preventDefault();
    cmdkResults[cmdkActive].classList.remove('active');
    cmdkActive = (cmdkActive - 1 + cmdkResults.length) % cmdkResults.length;
    cmdkResults[cmdkActive].classList.add('active');
    cmdkResults[cmdkActive].scrollIntoView({ block:'nearest' });
  } else if (e.key === 'Enter'){
    e.preventDefault();
    const it = cmdkResults[cmdkActive];
    if (it){
      navigateTo(it.dataset.go);
      closeCmdK();
    }
  }
});

// Cerrar selector de sociedad cuando se clickea fuera
document.addEventListener('click', e => {
  if (!e.target.closest('.sb2-soc')){
    closeSocMenu();
  }
});

document.addEventListener('click', e => {
  // Click en backdrop del Cmd+K → cerrar
  const back = e.target.closest('.sb2-cmdk-back');
  if (back && e.target === back){ closeCmdK(); return; }

  // Click en item del Cmd+K
  const it = e.target.closest('.sb2-cmdk-item');
  if (it){
    navigateTo(it.dataset.go);
    closeCmdK();
  }
});

// Input del Cmd+K
document.addEventListener('input', e => {
  if (e.target.id === 'sb2-cmdk-input'){
    renderCmdK(e.target.value);
  }
});

// ═══════════ Init ═══════════
async function init(){
  const ok = await fetchSidebarData();
  if (!ok){
    console.warn('[SB2] Fallback: dejando el sidebar viejo visible');
    return;
  }
  buildSidebar();
  console.log('[SB2] Sidebar v2 montado ·', SIDEBAR_DATA.total, 'módulos · ', FAVORITOS.length, 'favoritos');
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exponer al global por si necesitamos invocarlo desde el panel viejo
window.SidebarV2 = { reload: init, navigateTo };

})();
