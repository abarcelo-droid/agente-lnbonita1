/* src/sidebar-v2.js
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Sidebar dinÃ¡mico v2 para LNB Panel.
 *
 * Reemplaza al <nav> viejo del panel.html sin tocarlo (lo esconde).
 * Lee mÃ³dulos visibles de /api/org/sidebar y favoritos del usuario
 * desde /api/usuario/favoritos. Recientes y modo compacto se guardan
 * en localStorage.
 *
 * Compatible con:
 *   - window.navTo(modulo)     â† funciÃ³n existente en panel.html para cambiar de secciÃ³n
 *   - window.doLogout()        â† cerrar sesiÃ³n
 *   - window.abrirCambiarPassword()
 *   - window.paIrAClima()      â† widget del clima
 *
 * Si alguna no existe, el sidebar muestra un alert como fallback.
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

(function(){
'use strict';

const LS_RECIENTES = 'lnb-recientes';
const LS_DENSITY   = 'lnb-sidebar-density';
const LS_COLLAPSED = 'lnb-sidebar-collapsed-groups';
const LS_SOCIEDAD  = 'lnb-sidebar-sociedad';
const MAX_RECIENTES = 4;

// â”€â”€ QUÃ‰ VERSIÃ“N ESTÃS VIENDO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// El nÃºmero del Ãºltimo cambio mergeado (el nÃºmero del PR). Se muestra abajo, al
// lado del usuario.
//
// Para quÃ©: mirando una pantalla no hay forma de saber si el arreglo que se
// acaba de mergear ya estÃ¡ o todavÃ­a estÃ¡s viendo la pÃ¡gina vieja del navegador.
// Media hora de "no funciona" que en realidad era un Ctrl+F5.
//
// SE ACTUALIZA A MANO, en el mismo cambio que se mergea. Sacarlo de git en el
// arranque sonaba mejor, pero Railway despliega desde una copia sin historial:
// dirÃ­a siempre lo mismo y mentirÃ­a, que es peor que no estar.
const VERSION = 'V981';

let SIDEBAR_DATA = { grupos: [], modulos: [] };
let SOCIEDADES = [];                             // array de {id, nombre, funcion}
// SIEMPRE hay una empresa elegida. La opciÃ³n "Todas" se sacÃ³: con ella el menÃº
// mostraba los Ã­tems de las cuatro y no se sabÃ­a sobre quÃ© datos trabajaba cada
// pantalla. Arranca en null sÃ³lo hasta que fetchSidebarData elige una.
let CURRENT_SOCIEDAD = null;                     // sociedad_id (number), nunca 'all'
let FAVORITOS = [];
let RECIENTES = [];
let MODULO_INDEX = {};

// â•â•â•â•â•â•â•â•â•â•â• Util â•â•â•â•â•â•â•â•â•â•â•
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
  let r = getRecientes().filter(m => m !== modulo);
  r.unshift(modulo);
  r = r.slice(0, MAX_RECIENTES);
  localStorage.setItem(LS_RECIENTES, JSON.stringify(r));
  RECIENTES = r;
  renderRecientes();
}

// â•â•â•â•â•â•â•â•â•â•â• Data fetch â•â•â•â•â•â•â•â•â•â•â•
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

  // â”€â”€ SIEMPRE UNA EMPRESA ELEGIDA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Se restaura la Ãºltima, y si no hay ninguna guardada â€”o la guardada ya no
  // existe, o decÃ­a 'all' de antesâ€” se elige la primera. Dejarlo sin elegir
  // serÃ­a volver a "Todas" con otro nombre: el menÃº no sabrÃ­a quÃ© mostrar y las
  // llamadas al servidor irÃ­an sin empresa.
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

// Helper: Â¿este mÃ³dulo debe mostrarse segÃºn el filtro actual de sociedad?
function shouldShow(m){
  // Sin empresa elegida todavÃ­a (el primer instante de la carga) no se filtra:
  // si no, el menÃº parpadearÃ­a vacÃ­o.
  if (CURRENT_SOCIEDAD === null) return true;
  // Un mÃ³dulo sin empresa se ve desde todas. No deberÃ­a quedar ninguno â€”
  // ensure_modulo_empresas.js los asigna y avisa por consola si sobra algunoâ€”
  // pero si aparece uno nuevo es mejor que se vea a que desaparezca sin rastro.
  if (!m.sociedad_id) return true;
  return m.sociedad_id === CURRENT_SOCIEDAD;
}

// â•â•â•â•â•â•â•â•â•â•â• Render principal â•â•â•â•â•â•â•â•â•â•â•
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
        <div class="sb2-brand-name" id="sb2-brand-name">La NiÃ±a Bonita</div>
        <div class="sb2-brand-sub" id="sb2-brand-sub">Sistema de gestiÃ³n</div>
      </div>
      <div class="sb2-avatar" title="${escapeHtml(userName)}${userRole ? ' Â· ' + escapeHtml(userRole) : ''}" data-action="user-menu">
        ${escapeHtml(initials)}
        <span class="sb2-av-pip" title="En lÃ­nea"></span>
      </div>
    </div>

    <!-- BÃºsqueda -->
    <div class="sb2-search" data-action="cmdk">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <span class="sb2-search-text">Buscar</span>
      <span class="sb2-kbd">âŒ˜K</span>
    </div>

    <!-- Selector de sociedad -->
    <div class="sb2-soc" id="sb2-soc"></div>

    <!-- Widget Hoy -->
    <div class="sb2-hoy" data-action="hoy">
      <div class="sb2-hoy-icon" id="sb2-hoy-icon">ðŸŒ¤ï¸</div>
      <div class="sb2-hoy-meta">
        <div class="sb2-hoy-temp" id="sb2-hoy-temp">â€”Â°</div>
        <div class="sb2-hoy-sub" id="sb2-hoy-sub">CarpinterÃ­a</div>
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

    <!-- Divider fuerte entre fast lanes y menÃº normal -->
    <div class="sb2-divider"></div>
    <div class="sb2-group-sec"><span class="sb2-label">MenÃº completo</span></div>

    <!-- Grupos -->
    <div id="sb2-grupos"></div>

    <!-- LNB APP (removido por pedido) -->

    <!-- User bar -->
    <div class="sb2-user">
      <div class="sb2-user-meta">
        <div class="sb2-user-name">${escapeHtml(userName)}</div>
        <div class="sb2-user-role">${escapeHtml(userRole || 'Operador')}
          <span class="sb2-version" title="VersiÃ³n desplegada â€” es el nÃºmero del Ãºltimo cambio que se mergeÃ³">${VERSION}</span>
        </div>
      </div>
      <button class="sb2-user-cog" data-action="cog" title="Cambiar contraseÃ±a / Cerrar sesiÃ³n">
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
        <input class="sb2-cmdk-input" id="sb2-cmdk-input" placeholder="Buscar secciÃ³nâ€¦" autocomplete="off">
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

// â•â•â•â•â•â•â•â•â•â•â• Render: Selector de Sociedad â•â•â•â•â•â•â•â•â•â•â•
// Mapeo nombre/funciÃ³n -> color semÃ¡ntico del trigger
function sociedadColor(sociedad){
  if (!sociedad) return 'todas';
  const nombre = (sociedad.nombre || '').toLowerCase();
  // Los dos primeros salen del logo de la casa: el bordÃ³ del lettering y el ocre
  // del medallÃ³n. Que el color sea el de la marca y no uno inventado es lo que
  // hace que se reconozca sin tener que leer el nombre.
  if (nombre.includes('san gerÃ³nimo') || nombre.includes('san geronimo')) return 'ocre';
  if (nombre.includes('puente cordÃ³n')   || nombre.includes('puente cordon')) return 'bordo';
  if (nombre.includes('barcelÃ³ transporte') || nombre.includes('barcelo transporte')) return 'azul';
  if (nombre.includes('familia')) return 'carbon';
  // Fallback por funciÃ³n si el nombre no matchea exactamente
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
  const currentLabel = activeSoc ? activeSoc.nombre : 'â€”';
  const currentColor = activeSoc ? sociedadColor(activeSoc) : 'todas';

  // El color pinta el MENÃš COMPLETO y el tÃ­tulo dice la empresa. Antes el color
  // llegaba sÃ³lo al botÃ³n del selector: habÃ­a que buscarlo para saber dÃ³nde se
  // estaba parado, y con tres empresas que comparten pantallas eso se pasa por alto.
  const sb2 = document.querySelector('.sb2');
  if (sb2) sb2.setAttribute('data-soc-color', currentColor);
  const bn = document.getElementById('sb2-brand-name');
  const bs = document.getElementById('sb2-brand-sub');
  if (bn && bs) {
    bn.textContent = activeSoc ? activeSoc.nombre.replace(/\s+(SA|SRL|S\.A\.|S\.R\.L\.)$/i, '') : 'La NiÃ±a Bonita';
    bs.textContent = 'Sistema de gestiÃ³n';
  }

  const FUNC_LABELS = {
    'productiva':  'ProducciÃ³n',
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

  // Sin opciÃ³n "Todas": el selector manda sobre quÃ© empresa y quÃ© tablas se
  // trabaja, asÃ­ que tiene que decir una.
  let menuHTML = '';
  const ordenFunc = ['productiva','comercial','transporte','estructura','otra'];
  for (const k of ordenFunc){
    if (!byFunc[k]) continue;
    // (Sin divider â€” los dots de color ya identifican el tipo)
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
      <span class="soc-ico">ðŸ¢</span>
      <span class="soc-label">${escapeHtml(currentLabel)}</span>
      <span class="soc-caret">â–¾</span>
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
  // todos los mÃ³dulos (y sus caches) relean con el nuevo sociedad_id. Multisociedad F1/F2/F3.
  if (nuevo !== prev){ location.reload(); return; }
  renderSocSelector();
  renderFavoritos();
  renderRecientes();
  renderGrupos();
}

// â•â•â•â•â•â•â•â•â•â•â• Render: Favoritos â•â•â•â•â•â•â•â•â•â•â•
function renderFavoritos(){
  const wrap = document.getElementById('sb2-favoritos-wrap');
  if (!wrap) return;
  const favs = FAVORITOS.map(m => MODULO_INDEX[m]).filter(m => m && shouldShow(m));
  if (!favs.length){
    wrap.innerHTML = `
      <div class="sb2-fastlane fav">
        <div class="sb2-group-sec">
          <span class="sb2-label">â­ Favoritos</span>
        </div>
        <div class="sb2-empty-fav">
          <span class="star-pulse">â˜…</span>
          <span>${FAVORITOS.length ? 'No hay favoritos en esta empresa. MarcÃ¡ con â˜… los que uses seguido.' : 'MarcÃ¡ tus secciones mÃ¡s usadas con la estrella para acceso rÃ¡pido desde acÃ¡.'}</span>
        </div>
      </div>
    `;
    return;
  }
  wrap.innerHTML = `
    <div class="sb2-fastlane fav">
      <div class="sb2-group-sec">
        <span class="sb2-label">â­ Favoritos</span>
        <span class="badge-count">${favs.length}</span>
      </div>
      ${favs.map(m => niHTML(m, true)).join('')}
    </div>
  `;
}

// â•â•â•â•â•â•â•â•â•â•â• Render: Recientes â•â•â•â•â•â•â•â•â•â•â•
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
        <span class="sb2-label">â± Recientes</span>
        <span class="badge-count">${recientesFiltrados.length}</span>
      </div>
      ${recientesFiltrados.map(m => niHTML(m, false)).join('')}
    </div>
  `;
}

// â•â•â•â•â•â•â•â•â•â•â• Render: Grupos â•â•â•â•â•â•â•â•â•â•â•
function renderGrupos(){
  const wrap = document.getElementById('sb2-grupos');
  if (!wrap) return;
  const collapsed = getCollapsedGroups();

  const gruposFiltrados = SIDEBAR_DATA.grupos
    .map(g => ({ ...g, items: g.items.filter(shouldShow) }))
    .filter(g => g.items.length > 0);

  if (!gruposFiltrados.length){
    // Sin un solo mÃ³dulo hay dos motivos posibles, y decir el equivocado manda a
    // la persona a buscar donde no es:
    //
    //  Â· No tiene NINGÃšN acceso cargado. Desde que rige "sin permisos no se ve
    //    nada", el menÃº vacÃ­o no es un error: es la respuesta. Pero hay que
    //    decirle quÃ© hacer, o se queda mirando una pantalla en blanco pensando
    //    que el sistema se rompiÃ³.
    //  Â· Tiene accesos, pero ninguno en la empresa que eligiÃ³ arriba.
    const tieneEnOtra = (SIDEBAR_DATA.grupos || [])
      .some(g => (g.items || []).length > 0);
    wrap.innerHTML = tieneEnOtra
      ? `<div style="padding:14px 16px;font-size:11.5px;color:rgba(255,255,255,.55);text-align:center;line-height:1.5">
           No tenÃ©s accesos en esta empresa.<br>ProbÃ¡ cambiÃ¡ndola arriba.
         </div>`
      : `<div style="padding:18px 16px;font-size:12px;color:rgba(255,255,255,.75);text-align:center;line-height:1.6">
           <div style="font-size:22px;margin-bottom:6px">ðŸ”‘</div>
           <b>TodavÃ­a no tenÃ©s accesos asignados.</b><br>
           <span style="color:rgba(255,255,255,.55)">Pedile a un administrador que te dÃ© permiso a los mÃ³dulos que necesitÃ¡s.</span>
         </div>`;
    return;
  }

  wrap.innerHTML = gruposFiltrados.map(g => {
    const isCollapsed = collapsed.includes(g.grupo);
    return `
      <div class="sb2-grp ${isCollapsed ? 'collapsed' : ''}" data-grp="${escapeHtml(g.grupo)}">
        <div class="sb2-grp-text">
          <span class="sb2-grp-ico">${groupIcon(g.grupo)}</span>
          <span>${escapeHtml(g.grupo)}</span>
        </div>
        <span class="sb2-grp-caret">â–¾</span>
      </div>
      <div class="sb2-grp-items">
        ${g.items.map(m => niHTML(m, false)).join('')}
      </div>
    `;
  }).join('');
}

function niHTML(m, isFavSection){
  const isFav = FAVORITOS.includes(m.modulo);
  const starClass = isFav ? 'sb2-star on' : 'sb2-star';
  const starTitle = isFav ? 'Quitar de favoritos' : 'Agregar a favoritos';
  // En la secciÃ³n favoritos no mostramos el botÃ³n duplicado
  const star = isFavSection
    ? `<span class="${starClass}" data-fav="${escapeHtml(m.modulo)}" title="${starTitle}">â˜…</span>`
    : `<span class="${starClass}" data-fav="${escapeHtml(m.modulo)}" title="${starTitle}">â˜…</span>`;
  return `
    <a class="sb2-ni" data-sec="${escapeHtml(m.modulo)}" href="#">
      <span class="sb2-ni-ico">${moduleIcon(m)}</span>
      <span class="sb2-ni-text">${escapeHtml(stripIconFromLabel(m.label))}</span>
      ${star}
    </a>
  `;
}

// Algunos labels del seed traen emoji al inicio ("ðŸŒ¤ï¸ Clima"); lo separamos para no duplicar
function stripIconFromLabel(label){
  if (!label) return '';
  // Quita emoji y espacio inicial si estÃ¡
  return label.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*/u, '');
}

// El autoelevador de Control Cooperativa. Va como SVG y no como emoji porque
// autoelevador NO EXISTE en Unicode: lo mÃ¡s cercano es un tractor, que no es lo
// que hace una cooperativa en el galpÃ³n. Dibujado con el mismo trazo que el
// resto del sidebar (currentColor + stroke 2), asÃ­ que se pinta solo cuando el
// Ã­tem estÃ¡ activo, cosa que un emoji no hace.
const ICO_AUTOELEVADOR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
  + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 17v-5h5l2-4h3v9"/>'   // la cabina, con el parabrisas inclinado
  + '<circle cx="6" cy="19" r="2"/><circle cx="13" cy="19" r="2"/>'
  + '<path d="M17 20V4"/>'             // el mÃ¡stil
  + '<path d="M17 5h3"/>'              // el respaldo de carga, arriba
  + '<path d="M17 17h4"/>'             // la uÃ±a, a la altura del piso
  + '</svg>';

function moduleIcon(m){
  // 1) Mapping manual prioritario â€” emojis por mÃ³dulo segÃºn el panel original
  const map = {
    // General / Sistema
    'inicio':            'âŒ‚',
    'calendario':        'ðŸ“…',
    'conv':              'ðŸ’¬',
    'equipo':            'ðŸ¢',
    'maestro-usuarios':  'ðŸ‘¥',
    'ingreso-factura':   'ðŸ§¾',
    // Comercial
    'crm':               'ðŸ’¼',
    'dedicados':         'â­',
    'food':              'ðŸ´',
    'may-a':             'ðŸª',
    'may-mcba':          'ðŸª',
    'min-mcba':          'ðŸ›’',
    'min-ent':           'ðŸšš',
    'cons-final':        'ðŸ‘¤',
    'pedidos':           'ðŸ“‹',
    'repet':             'ðŸ”',
    // Pricing / Oferta
    'pricing1':          'ðŸ’²',
    'pricing2':          'ðŸ’²',
    'oferta1':           'ðŸ·ï¸',
    'oferta2':           'ðŸ·ï¸',
    // LogÃ­stica
    'logistica':         'ðŸš›',
    'envios':            'ðŸ“¨',
    'preparacion':       'ðŸ“¦',
    'remitos':           'ðŸ“‹',
    'guardias':          'ðŸ•',
    // Cobranzas
    'cobranza':          'ðŸ’°',
    'cta-cte':           'ðŸ’³',
    // ProducciÃ³n AgrÃ­cola
    'pa-dashboard':      'ðŸŒ±',
    'pa-lotes':          'ðŸŒ¾',
    'pa-insumos':        'ðŸ§ª',
    'pa-clima':          'ðŸŒ¤ï¸',
    'pa-combustible':    'â›½',
    'pa-compras':        'ðŸ›’',
    'pa-costos':         'ðŸ’²',
    'pa-cuentas':        'ðŸ“Š',
    'pa-calendario':     'ðŸ“…',
    'pa-despachos':      'ðŸšš',
    'pa-electricidad':   'âš¡',
    'pa-ordenes':        'ðŸ“‹',
    'pa-panol':          'ðŸ”§',
    'pa-personal':       'ðŸ‘·',
    'pa-scout':          'ðŸ“±',
    'pli-planificacion': 'ðŸ“¦',
    'sp-pagos':          'ðŸ’¸',
    // San GerÃ³nimo
    'sg-control-coop':   ICO_AUTOELEVADOR,
    // Abasto IFCO
    'ab-dashboard':      'ðŸ“Š',
    'ab-gastos':         'ðŸ’¸',
    'ab-ifcos':          'ðŸ“¦',
    'ab-liquidaciones':  'ðŸ“„',
    'ab-mandata':        'ðŸ§¾',
    'ab-partidas':       'ðŸš›',
    'ab-proveedores':    'ðŸ­',
    'ab-remitos':        'ðŸ“‹',
    'ab-stock':          'ðŸ“¦',
    // Contabilidad
    'adm-asientos':      'ðŸ“’',
    'adm-cc-proveedores':'ðŸ’³',
    'adm-modelos':       'ðŸ“',
    'adm-plan-cuentas':  'ðŸ“Š',
    'adm-proveedores':   'ðŸ­',
    // Financiero
    'fin-caja-bancos':   'ðŸ¦',
    'fin-ordenes-pago':  'ðŸ“„',
    // Ventas
    'ven-clientes':      'ðŸ‘¥',
    'ven-facturas':      'ðŸ§¾',
    'ven-cobranzas':     'ðŸ’°',
    'ven-cc':            'ðŸ’³',
    'ven-liquidaciones': 'ðŸŒ¾',
    // Retail
    'retail-view':       'ðŸ›’',
    'retail-prod':       'ðŸŒ±',
    'retail-gastos':     'ðŸ’¸',
    'rent-retail':       'ðŸ“ˆ',
  };
  if (map[m.modulo]) return map[m.modulo];

  // 2) Si el label ya trae emoji al inicio (ej. "ðŸŒ¤ï¸ Clima"), usarlo
  const match = (m.label || '').match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?)/u);
  if (match) return match[1];

  // 3) Fallback por tipo
  const TIPO_ICONS = {
    'numero':    '#',
    'operativo': 'â€¢',
    'mobile':    'ðŸ“±',
    'externo':   'â†—',
    'sistema':   'âš™',
  };
  return TIPO_ICONS[m.tipo] || 'â€¢';
}

function groupIcon(grupo){
  const ICONS = {
    'General':       'âŒ‚',
    'Sistema':       'âš™',
    'Comercial':     'ðŸ’¼',
    'Pricing':       '$',
    'LogÃ­stica':     'ðŸšš',
    'Cobranzas':     'ðŸ’°',
    'ProducciÃ³n':    'ðŸŒ±',
    'Abasto IFCO':   'ðŸ“¦',
    'Contabilidad':  'ðŸ“’',
    'Financiero':    'ðŸ¦',
    'Ventas':        'ðŸ§¾',
    'Retail':        'ðŸ›’',
  };
  return ICONS[grupo] || 'Â·';
}

// â•â•â•â•â•â•â•â•â•â•â• Event handlers â•â•â•â•â•â•â•â•â•â•â•
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

    // Click en Ã­tem
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
  // El nav viejo estÃ¡ escondido (display:none) pero sus event listeners siguen activos â€”
  // disparamos la navegaciÃ³n real del panel.
  const oldNi = document.querySelector('nav .ni[data-sec="' + CSS.escape(modulo) + '"], #sidebar-old-hidden .ni[data-sec="' + CSS.escape(modulo) + '"]');
  if (oldNi){
    oldNi.click();
    return;
  }

  // Fallback: si por alguna razÃ³n no existe el .ni viejo, probamos con el sistema antiguo
  // de mostrar/ocultar .sec directamente
  console.warn('[SB2] No se encontrÃ³ .ni del nav viejo para "' + modulo + '" â€” fallback manual');
  document.querySelectorAll('.sec').forEach(s => s.classList.remove('on'));
  const sec = document.getElementById('sec-' + modulo);
  if (sec) sec.classList.add('on');
  window.scrollTo(0, 0);
}

function hookCurrentSection(){
  // â”€â”€ DÃ“NDE ABRE EL PANEL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Los mÃ³dulos que esta empresa tiene. Es la Ãºnica lista que vale: el menÃº ya
  // no muestra lo de las otras.
  const suyos = (SIDEBAR_DATA.grupos || []).flatMap(g => g.items || []).filter(shouldShow);

  // El nav viejo trae "Inicio" marcado como activo en el HTML (panel.html:312).
  // Eso se respetaba SIEMPRE, asÃ­ que el panel abrÃ­a en Inicio pase lo que pase
  // â€” y como Inicio es de San GerÃ³nimo, parado en Puente CordÃ³n o en BarcelÃ³ se
  // veÃ­an los pedidos y el CRM de San GerÃ³nimo con el cartel diciendo otra cosa.
  //
  // Ahora se respeta sÃ³lo si ese mÃ³dulo es DE ESTA EMPRESA. Si no, se ignora.
  const onItem = document.querySelector('nav .ni.on');
  const pedido = onItem && onItem.dataset ? onItem.dataset.sec : null;
  const sirve = pedido && suyos.some(m => m.modulo === pedido);

  if (sirve){ navigateTo(pedido); return; }

  const inicio = suyos.find(m => m.modulo === 'inicio');
  const primero = inicio || suyos[0];
  if (primero){ navigateTo(primero.modulo); return; }

  // Sin un solo mÃ³dulo no hay dÃ³nde ir: se apagan TODAS las secciones para no
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
  // TambiÃ©n actualizar stars en grupos
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
    items.push({ label: 'ðŸ”‘ Cambiar contraseÃ±a', fn: window.abrirCambiarPassword });
  if (typeof window.doLogout === 'function')
    items.push({ label: 'ðŸšª Cerrar sesiÃ³n', fn: window.doLogout });

  if (!items.length){
    alert('MenÃº de usuario\n(En este panel no hay funciones de logout disponibles)');
    return;
  }

  // MenÃº simple via confirm si son 2 acciones; sino primero
  if (items.length === 2){
    const cambiar = confirm('Â¿Cambiar contraseÃ±a? (cancelar = cerrar sesiÃ³n)');
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

// â•â•â•â•â•â•â•â•â•â•â• Clima (proxy a SMN) â•â•â•â•â•â•â•â•â•â•â•
async function fetchClima(){
  try {
    const r = await fetch('/api/pa/clima/smn', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    if (!json?.ok || !json.data) return;

    const d = json.data;
    const w = d.weather || {};

    // SMN devuelve: temp (Â°C), humidity (%), wind_speed (km/h), wind_deg, description, ...
    const temp = w.temp ?? w.temperatura;
    const desc = w.description || w.descripcion || '';

    if (temp != null && !isNaN(temp)){
      const el = document.getElementById('sb2-hoy-temp');
      if (el) el.textContent = Math.round(temp) + 'Â°';
    }
    const iconEl = document.getElementById('sb2-hoy-icon');
    if (iconEl) iconEl.textContent = climaEmoji(desc);

    const sub = document.getElementById('sb2-hoy-sub');
    if (sub){
      const ubic = d.estacion || 'CarpinterÃ­a';
      // Capitalizar descripciÃ³n y mostrarla bonita
      const descLabel = desc ? (desc.charAt(0).toUpperCase() + desc.slice(1).toLowerCase()) : '';
      let html = escapeHtml(ubic);
      if (descLabel) html += '<span class="sb2-alert" style="color:rgba(255,255,255,.55);font-weight:600">' + escapeHtml(descLabel) + '</span>';
      sub.innerHTML = html;
    }
  } catch(e) {
    console.warn('[SB2] No se pudo cargar el clima:', e.message);
    // Se queda con el placeholder "â€”Â° / CarpinterÃ­a"
  }
}
function climaEmoji(desc){
  const d = (desc || '').toLowerCase();
  if (d.includes('lluv') || d.includes('rain') || d.includes('lluvi'))   return 'ðŸŒ§ï¸';
  if (d.includes('tormenta') || d.includes('storm'))                       return 'â›ˆï¸';
  if (d.includes('nubl') || d.includes('cloud'))                           return 'â›…';
  if (d.includes('parc') || d.includes('algo nub'))                        return 'â›…';
  if (d.includes('sol')  || d.includes('clear') || d.includes('despej'))   return 'â˜€ï¸';
  if (d.includes('nieve')|| d.includes('snow'))                            return 'â„ï¸';
  if (d.includes('niebla') || d.includes('fog') || d.includes('bruma'))    return 'ðŸŒ«ï¸';
  return 'ðŸŒ¤ï¸';
}

// â•â•â•â•â•â•â•â•â•â•â• Cmd+K palette â•â•â•â•â•â•â•â•â•â•â•
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
  const allItems = Object.values(MODULO_INDEX);

  if (!q){
    const favItems    = FAVORITOS.map(m => MODULO_INDEX[m]).filter(Boolean);
    const recItems    = RECIENTES.filter(m => !FAVORITOS.includes(m)).map(m => MODULO_INDEX[m]).filter(Boolean);
    const groups = [];
    if (favItems.length) groups.push({ label: 'â­ Favoritos',   items: favItems });
    if (recItems.length) groups.push({ label: 'â± Recientes',   items: recItems });
    // Si no hay favoritos ni recientes, sugerir los primeros por orden
    if (!groups.length) groups.push({ label: 'ðŸ“ Sugeridos', items: allItems.slice(0, 8) });

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
  // Click en backdrop del Cmd+K â†’ cerrar
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

// â•â•â•â•â•â•â•â•â•â•â• Init â•â•â•â•â•â•â•â•â•â•â•
async function init(){
  const ok = await fetchSidebarData();
  if (!ok){
    console.warn('[SB2] Fallback: dejando el sidebar viejo visible');
    return;
  }
  buildSidebar();
  console.log('[SB2] Sidebar v2 montado Â·', SIDEBAR_DATA.total, 'mÃ³dulos Â· ', FAVORITOS.length, 'favoritos');
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exponer al global por si necesitamos invocarlo desde el panel viejo
window.SidebarV2 = { reload: init, navigateTo };

})();
