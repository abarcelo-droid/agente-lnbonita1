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
const MAX_RECIENTES = 4;

let SIDEBAR_DATA = { grupos: [], modulos: [] };  // cache de la data
let FAVORITOS = [];                              // array de strings (modulo)
let RECIENTES = [];                              // array de strings (modulo)
let MODULO_INDEX = {};                           // modulo -> {label, grupo, sociedad_nombre, ...}

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
  let r = getRecientes().filter(m => m !== modulo);
  r.unshift(modulo);
  r = r.slice(0, MAX_RECIENTES);
  localStorage.setItem(LS_RECIENTES, JSON.stringify(r));
  RECIENTES = r;
  renderRecientes();
}

// ═══════════ Data fetch ═══════════
async function fetchSidebarData(){
  const [sidebarResp, favsResp] = await Promise.allSettled([
    fetch('/api/org/sidebar',       { credentials: 'same-origin' }).then(r => r.json()),
    fetch('/api/usuario/favoritos', { credentials: 'same-origin' }).then(r => r.json()),
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

  RECIENTES = getRecientes().filter(m => MODULO_INDEX[m]);  // limpiar recientes que ya no existen
  return true;
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
        <div class="sb2-brand-name">La Niña Bonita</div>
        <div class="sb2-brand-sub">Sistema de gestión</div>
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

    <!-- Grupos -->
    <div id="sb2-grupos"></div>

    <!-- LNB APP -->
    <a class="sb2-app" href="/scout" target="_self">
      <span style="font-size:14px">📱</span>
      <span class="sb2-app-text">LNB APP</span>
    </a>

    <!-- User bar -->
    <div class="sb2-user">
      <div class="sb2-user-meta">
        <div class="sb2-user-name">${escapeHtml(userName)}</div>
        <div class="sb2-user-role">${escapeHtml(userRole || 'Operador')}</div>
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

  renderFavoritos();
  renderRecientes();
  renderGrupos();
  attachEventListeners();
  hookCurrentSection();
  fetchClima();
}

// ═══════════ Render: Favoritos ═══════════
function renderFavoritos(){
  const wrap = document.getElementById('sb2-favoritos-wrap');
  if (!wrap) return;
  if (!FAVORITOS.length){ wrap.innerHTML = ''; return; }

  wrap.innerHTML = `
    <div class="sb2-group-sec"><span class="sb2-label">⭐ Favoritos</span></div>
    ${FAVORITOS.map(modulo => {
      const m = MODULO_INDEX[modulo];
      if (!m) return '';
      return niHTML(m, true);
    }).join('')}
  `;
}

// ═══════════ Render: Recientes ═══════════
function renderRecientes(){
  const wrap = document.getElementById('sb2-recientes-wrap');
  if (!wrap) return;
  // No mostrar items que ya están en favoritos
  const recientesFiltrados = RECIENTES.filter(m => !FAVORITOS.includes(m));
  if (!recientesFiltrados.length){ wrap.innerHTML = ''; return; }

  wrap.innerHTML = `
    <div class="sb2-group-sec"><span class="sb2-label">⏱ Recientes</span></div>
    ${recientesFiltrados.map(modulo => {
      const m = MODULO_INDEX[modulo];
      if (!m) return '';
      return niHTML(m, false);
    }).join('')}
  `;
}

// ═══════════ Render: Grupos ═══════════
function renderGrupos(){
  const wrap = document.getElementById('sb2-grupos');
  if (!wrap) return;
  const collapsed = getCollapsedGroups();

  wrap.innerHTML = SIDEBAR_DATA.grupos.map(g => {
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

function moduleIcon(m){
  // Si el label arranca con emoji, usar ese
  const match = (m.label || '').match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?)/u);
  if (match) return match[1];
  // Fallback por tipo
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
  // Marcar como activo
  document.querySelectorAll('.sb2-ni').forEach(n => n.classList.remove('on'));
  document.querySelectorAll('.sb2-ni[data-sec="' + CSS.escape(modulo) + '"]').forEach(n => n.classList.add('on'));

  // Llamar a la función existente del panel viejo
  if (typeof window.navTo === 'function'){
    window.navTo(modulo);
  } else {
    // Fallback: emular el sistema viejo (mostrar/ocultar .sec)
    document.querySelectorAll('.sec').forEach(s => s.classList.remove('on'));
    const sec = document.getElementById('sec-' + modulo);
    if (sec) sec.classList.add('on');
    window.scrollTo(0, 0);
  }
}

function hookCurrentSection(){
  // Detectar qué sección está activa en el nav viejo y marcar la nueva igual
  const onItem = document.querySelector('nav .ni.on');
  if (onItem){
    const sec = onItem.dataset.sec;
    if (sec) navigateTo(sec);
  } else {
    // Default: inicio
    if (MODULO_INDEX['inicio']) navigateTo('inicio');
  }
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

// ═══════════ Clima ═══════════
async function fetchClima(){
  try {
    const r = await fetch('/api/pa/clima/actual', { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data?.ok) return;
    const c = data.clima || data;
    const temp = c.temperatura ?? c.temp ?? c.t;
    if (temp != null) document.getElementById('sb2-hoy-temp').textContent = Math.round(temp) + '°';
    const icon = c.emoji || climaEmoji(c.condicion || c.descripcion || '');
    if (icon) document.getElementById('sb2-hoy-icon').textContent = icon;
    const ubic = c.ubicacion || c.localidad || 'Carpintería';
    const sub = document.getElementById('sb2-hoy-sub');
    let html = escapeHtml(ubic);
    if (c.alerta || data.alerta){
      const a = c.alerta || data.alerta;
      html += `<span class="sb2-alert">⚠ ${escapeHtml(a)}</span>`;
    }
    sub.innerHTML = html;
  } catch(_) { /* sin clima — se queda el placeholder */ }
}
function climaEmoji(desc){
  const d = (desc || '').toLowerCase();
  if (d.includes('lluv') || d.includes('rain'))   return '🌧️';
  if (d.includes('nubl') || d.includes('cloud'))  return '⛅';
  if (d.includes('sol')  || d.includes('clear') || d.includes('despej')) return '☀️';
  if (d.includes('nieve')|| d.includes('snow'))   return '❄️';
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
  const allItems = Object.values(MODULO_INDEX);

  if (!q){
    const favItems    = FAVORITOS.map(m => MODULO_INDEX[m]).filter(Boolean);
    const recItems    = RECIENTES.filter(m => !FAVORITOS.includes(m)).map(m => MODULO_INDEX[m]).filter(Boolean);
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
