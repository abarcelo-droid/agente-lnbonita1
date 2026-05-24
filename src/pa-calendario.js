/* ═══════════════════════════════════════════════════════════════════════
 * pa-calendario.js — Mejoras al módulo Calendario Agrícola
 *
 * Agrega (sin tocar el modal de edición):
 *   - Search bar (lote / finca / cultivo) con fly-to en mapa
 *   - Chips KPI mejorados arriba (reemplazan el resumen simple)
 *   - Vista Timeline / Gantt como 3er botón del toggle
 *   - Bloque "Órdenes activas" inyectado en el modal de editar lote
 *
 * NO toca: paLoadCalendario, paCalRenderMapa, paEditarCultivo (lógica original)
 * ═══════════════════════════════════════════════════════════════════════ */

(function(){
'use strict';

const MES_NOMBRES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ═════════ Estado interno ═════════
const STATE = {
  vista: 'tabla',           // 'tabla' | 'mapa' | 'timeline'
  filtroCultivo: null,      // null o nombre del cultivo
  campañaActual: null,      // nombre de la campaña visible
  inited: false,
};

// ═════════ Cuando el panel carga el calendario, montamos las mejoras ═════════
// El sec-pa-calendario se carga via paLoadCalendario, así que envolvemos esa función.
function wrapLoadCalendario(){
  if (typeof window.paLoadCalendario !== 'function') {
    // Si todavía no está definida, reintentar
    return setTimeout(wrapLoadCalendario, 200);
  }
  const orig = window.paLoadCalendario;
  window.paLoadCalendario = function(){
    const result = orig.apply(this, arguments);
    // Post-render: inyectar nuestras mejoras
    setTimeout(injectMejoras, 80);
    return result;
  };
  console.log('[pa-calendario] wrap de paLoadCalendario instalado');
}

// ═════════ Inyectar mejoras al DOM existente ═════════
function injectMejoras(){
  const sec = document.getElementById('sec-pa-calendario');
  if (!sec) return;

  // 1) Toolbar (search + KPIs) — antes del resumen viejo
  if (!sec.querySelector('.pac-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.className = 'pac-toolbar';
    toolbar.innerHTML = toolbarHTML();
    const resumen = document.getElementById('pa-cal-resumen');
    if (resumen) sec.insertBefore(toolbar, resumen);
    else sec.querySelector('.ph')?.after(toolbar);
    attachSearchListeners();
  }

  // 2) Reemplazar el resumen viejo con chips KPI
  renderChipsKPI();

  // 3) Agregar botón "Timeline" al toggle de vistas
  injectTimelineToggle();

  // 4) Crear contenedor de timeline si no existe
  if (!document.getElementById('pa-cal-vista-timeline-cont')) {
    const tlCont = document.createElement('div');
    tlCont.id = 'pa-cal-vista-timeline-cont';
    tlCont.style.display = 'none';
    tlCont.innerHTML = '<div class="pac-timeline" id="pa-cal-timeline-host"></div>';
    const mapaCont = document.getElementById('pa-cal-vista-mapa-cont');
    if (mapaCont) mapaCont.after(tlCont);
  }

  // 5) Actualizar KPIs al cambiar campaña
  const sel = document.getElementById('cal-campaña-sel');
  if (sel && !sel.dataset.pacWrapped) {
    sel.dataset.pacWrapped = '1';
    sel.addEventListener('change', () => setTimeout(renderChipsKPI, 100));
  }
}

// ═════════ Toolbar HTML ═════════
function toolbarHTML(){
  return `
    <div class="pac-search" id="pac-search">
      <div class="pac-search-inner">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
        </svg>
        <input id="pac-search-input" placeholder="Buscar lote, finca o cultivo…" autocomplete="off">
      </div>
      <div class="pac-search-results" id="pac-search-results"></div>
    </div>
    <div class="pac-kpis" id="pac-kpis"></div>
  `;
}

function attachSearchListeners(){
  const input = document.getElementById('pac-search-input');
  const wrap = document.getElementById('pac-search');
  if (!input || !wrap) return;

  input.addEventListener('input', e => renderSearchResults(e.target.value));
  input.addEventListener('focus', () => { if (input.value) wrap.classList.add('open'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.pac-search')) wrap.classList.remove('open');
  });
}

function renderSearchResults(q){
  const wrap = document.getElementById('pac-search');
  const list = document.getElementById('pac-search-results');
  if (!wrap || !list) return;
  q = (q || '').trim().toLowerCase();
  if (!q){ wrap.classList.remove('open'); return; }
  wrap.classList.add('open');

  const lotes = (window.PA && PA.lotes) ? PA.lotes : [];
  const camp = getCampanaActual();
  const results = lotes.filter(l => {
    const cult = getCultivoLote(l, camp);
    return (l.nombre || '').toLowerCase().includes(q)
        || (l.finca || '').toLowerCase().includes(q)
        || (cult || '').toLowerCase().includes(q);
  }).slice(0, 8);

  if (!results.length){
    list.innerHTML = `<div class="pac-search-empty">Sin resultados para "${esc(q)}"</div>`;
    return;
  }

  list.innerHTML = results.map(l => {
    const cult = getCultivoLote(l, camp);
    const col = window.cultColor ? window.cultColor(cult || '') : { bg:'#f1f5f9', fg:'#64748b' };
    const pillHTML = cult
      ? `<span class="pac-search-item-pill" style="background:${col.bg};color:${col.fg}">${esc(cult)}</span>`
      : `<span class="pac-search-item-empty">sin asignar</span>`;
    return `
      <button class="pac-search-item" data-lote-id="${l.id}">
        <span class="pac-search-item-main">
          <b class="pac-search-item-nombre">${esc(l.nombre)}</b>
          <span class="pac-search-item-finca">${esc(l.finca || '—')}</span>
        </span>
        ${pillHTML}
        <span class="pac-search-item-ha">${esc(l.hectareas || '?')} ha</span>
      </button>
    `;
  }).join('');

  list.querySelectorAll('[data-lote-id]').forEach(b => {
    b.addEventListener('click', () => {
      const id = parseInt(b.dataset.loteId, 10);
      handleSearchSelect(id);
      wrap.classList.remove('open');
      document.getElementById('pac-search-input').value = '';
    });
  });
}

function handleSearchSelect(loteId){
  const lote = (PA.lotes || []).find(l => l.id === loteId);
  if (!lote) return;

  // Si estamos en mapa, hacer fly-to al polígono
  if (STATE.vista === 'mapa' && window.PAMAP && PAMAP.calMap && lote.poligono_geojson) {
    try {
      const geo = typeof lote.poligono_geojson === 'string' ? JSON.parse(lote.poligono_geojson) : lote.poligono_geojson;
      const tempLayer = L.geoJSON(geo);
      const b = tempLayer.getBounds();
      if (b.isValid()) PAMAP.calMap.flyToBounds(b, { padding: [60, 60], duration: 1, maxZoom: 18 });
    } catch(e) { console.warn('Error fly-to:', e); }
  } else if (STATE.vista === 'tabla') {
    // Highlight la fila correspondiente
    const row = document.querySelector(`[data-cal-lote-id="${loteId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.style.transition = 'background .3s';
      row.style.background = '#FFF4D6';
      setTimeout(() => { row.style.background = ''; }, 1500);
    }
  } else if (STATE.vista === 'timeline') {
    // Scroll a la fila del timeline
    const tlRow = document.querySelector(`[data-tl-lote-id="${loteId}"]`);
    if (tlRow) {
      tlRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      tlRow.style.transition = 'background .3s';
      tlRow.style.background = '#FFF4D6';
      setTimeout(() => { tlRow.style.background = ''; }, 1500);
    }
  }
}

// ═════════ KPIs (chips arriba) ═════════
function renderChipsKPI(){
  const kpisEl = document.getElementById('pac-kpis');
  const lotes = (window.PA && PA.lotes) ? PA.lotes : [];
  if (!lotes.length) return;

  const haTotal = lotes.reduce((s, l) => s + (parseFloat(l.hectareas) || 0), 0);
  const camp = getCampanaActual();
  const conCultivo = lotes.filter(l => getCultivoLote(l, camp));
  const haAsignadas = conCultivo.reduce((s, l) => s + (parseFloat(l.hectareas) || 0), 0);
  const haSinAsig = haTotal - haAsignadas;

  if (kpisEl) {
    kpisEl.innerHTML = `
      <div class="pac-kpi">
        <div class="pac-kpi-label">Asignadas</div>
        <div class="pac-kpi-value">${haAsignadas.toFixed(1)} <span class="pac-kpi-unit">ha</span></div>
      </div>
      <div class="pac-kpi-divider"></div>
      <div class="pac-kpi">
        <div class="pac-kpi-label">Sin asignar</div>
        <div class="pac-kpi-value" style="color:${haSinAsig > 0 ? 'var(--pac-bordo)' : '#1F8A5B'}">${haSinAsig.toFixed(1)} <span class="pac-kpi-unit">ha</span></div>
      </div>
      <div class="pac-kpi-divider"></div>
      <div class="pac-kpi">
        <div class="pac-kpi-label">% completo</div>
        <div class="pac-kpi-value">${Math.round(haAsignadas/haTotal*100)}<span class="pac-kpi-unit">%</span></div>
      </div>
    `;
  }

  // Reemplazar el resumen viejo con chips
  const resumen = document.getElementById('pa-cal-resumen');
  if (!resumen) return;

  // Calcular ha por cultivo
  const map = {};
  for (const l of lotes) {
    const cult = getCultivoLote(l, camp);
    if (!cult) continue;
    if (!map[cult]) map[cult] = { cultivo: cult, lotes: 0, ha: 0 };
    map[cult].lotes += 1;
    map[cult].ha += parseFloat(l.hectareas) || 0;
  }
  const items = Object.values(map).sort((a,b) => b.ha - a.ha);

  resumen.className = 'pac-chips';
  resumen.innerHTML = `
    <button class="pac-chip total ${STATE.filtroCultivo === null ? 'active' : ''}" data-cult="" type="button">
      <div class="pac-chip-label">TOTAL</div>
      <div class="pac-chip-value">${haTotal.toFixed(1)} <span class="pac-chip-unit">ha</span></div>
      <div class="pac-chip-meta">${esc(camp || 'sin campaña')}</div>
    </button>
    ${items.map(r => {
      const col = window.cultColor ? cultColor(r.cultivo) : { bg:'#e0f2fe', fg:'#075985' };
      const isActive = STATE.filtroCultivo === r.cultivo;
      const pct = Math.round(r.ha / haTotal * 100);
      return `
        <button class="pac-chip ${isActive ? 'active' : ''}" data-cult="${esc(r.cultivo)}" type="button"
          style="background:${col.bg};border-color:${col.fg};color:${col.fg};${STATE.filtroCultivo && !isActive ? 'opacity:.55;' : ''}">
          <div class="pac-chip-label">${esc(r.cultivo.toUpperCase())}</div>
          <div class="pac-chip-value">${r.ha.toFixed(1)} <span class="pac-chip-unit">ha</span></div>
          <div class="pac-chip-meta">${r.lotes} ${r.lotes === 1 ? 'lote' : 'lotes'} · ${pct}%</div>
        </button>
      `;
    }).join('')}
    ${haSinAsig > 0 ? `
      <div class="pac-chip" style="background:#F4F1E8;border-color:transparent;color:var(--pac-bordo)">
        <div class="pac-chip-label">SIN ASIGNAR</div>
        <div class="pac-chip-value">${haSinAsig.toFixed(1)} <span class="pac-chip-unit">ha</span></div>
        <div class="pac-chip-meta">${Math.round(haSinAsig/haTotal*100)}%</div>
      </div>
    ` : ''}
  `;
  resumen.querySelectorAll('[data-cult]').forEach(b => {
    b.addEventListener('click', () => {
      const cult = b.dataset.cult;
      STATE.filtroCultivo = cult === '' ? null : (STATE.filtroCultivo === cult ? null : cult);
      renderChipsKPI();
      // Si estamos en timeline, re-renderizar para aplicar filtro
      if (STATE.vista === 'timeline') renderTimeline();
    });
  });
}

// ═════════ Toggle de vista — agregar botón Timeline ═════════
function injectTimelineToggle(){
  // Buscar el div del toggle viejo (tiene botones #pa-cal-vista-tabla y #pa-cal-vista-mapa)
  const btnTabla = document.getElementById('pa-cal-vista-tabla');
  const btnMapa  = document.getElementById('pa-cal-vista-mapa');
  if (!btnTabla || !btnMapa) return;

  // Si ya inyectamos, salir
  if (document.getElementById('pa-cal-vista-timeline')) return;

  const btnTimeline = document.createElement('button');
  btnTimeline.id = 'pa-cal-vista-timeline';
  btnTimeline.type = 'button';
  btnTimeline.style.cssText = 'border:none;background:transparent;color:var(--mut);padding:5px 12px;font-size:12px;border-radius:6px;cursor:pointer;font-weight:700';
  btnTimeline.innerHTML = '📅 Timeline';
  btnTimeline.addEventListener('click', () => switchVista('timeline'));
  btnMapa.after(btnTimeline);

  // Reemplazar el comportamiento de los otros 2 para que oculten timeline también
  if (typeof window.paCalVista === 'function' && !window.paCalVista._pacWrapped) {
    const origVista = window.paCalVista;
    window.paCalVista = function(v){
      const r = origVista.apply(this, arguments);
      hideTimeline();
      STATE.vista = v;
      // Update visual del botón timeline
      btnTimeline.style.background = 'transparent';
      btnTimeline.style.color = 'var(--mut)';
      return r;
    };
    window.paCalVista._pacWrapped = true;
  }
}

function switchVista(v){
  STATE.vista = v;
  if (v === 'timeline'){
    // Ocultar los otros
    const ct = document.getElementById('pa-cal-vista-tabla-cont');
    const cm = document.getElementById('pa-cal-vista-mapa-cont');
    const cl = document.getElementById('pa-cal-vista-timeline-cont');
    if (ct) ct.style.display = 'none';
    if (cm) cm.style.display = 'none';
    if (cl) cl.style.display = '';
    // Update botones
    const bT = document.getElementById('pa-cal-vista-tabla');
    const bM = document.getElementById('pa-cal-vista-mapa');
    const bL = document.getElementById('pa-cal-vista-timeline');
    if (bT) { bT.style.background='transparent'; bT.style.color='var(--mut)'; }
    if (bM) { bM.style.background='transparent'; bM.style.color='var(--mut)'; }
    if (bL) { bL.style.background='var(--burg)'; bL.style.color='#fff'; }
    renderTimeline();
  } else if (typeof window.paCalVista === 'function') {
    window.paCalVista(v);
  }
}

function hideTimeline(){
  const cl = document.getElementById('pa-cal-vista-timeline-cont');
  if (cl) cl.style.display = 'none';
  const bL = document.getElementById('pa-cal-vista-timeline');
  if (bL) { bL.style.background='transparent'; bL.style.color='var(--mut)'; }
}

// ═════════ Vista Timeline / Gantt ═════════
function renderTimeline(){
  const host = document.getElementById('pa-cal-timeline-host');
  if (!host) return;
  const lotes = (window.PA && PA.lotes) ? PA.lotes : [];
  if (!lotes.length){ host.innerHTML = '<div class="emp">No hay lotes cargados</div>'; return; }

  const camp = getCampanaActual();
  const mesHoy = new Date().getMonth() + 1;

  // Agrupar por finca
  const byFinca = {};
  for (const l of lotes) {
    const f = l.finca || 'Sin finca';
    if (!byFinca[f]) byFinca[f] = [];
    byFinca[f].push(l);
  }
  const fincas = Object.keys(byFinca).sort();

  host.innerHTML = `
    <div class="pac-tl-header">
      <div class="pac-tl-header-lote">Lote</div>
      <div class="pac-tl-header-meses">
        ${MES_NOMBRES.map((m, idx) => `<div class="pac-tl-header-mes ${idx % 3 === 0 ? 'trim' : ''} ${mesHoy === idx+1 ? 'hoy' : ''}">${m}</div>`).join('')}
      </div>
    </div>
    <div class="pac-tl-body" id="pac-tl-body"></div>
    <div class="pac-tl-footer">
      <div class="pac-tl-legend">
        <span class="pac-tl-legend-item">▼ Siembra</span>
        <span class="pac-tl-legend-item">🌾 Cosecha</span>
        <span class="pac-tl-legend-item"><span class="pac-tl-legend-swatch"></span>Perenne / frutal</span>
      </div>
      <div class="pac-tl-stats">${lotes.length} lotes · ${lotes.reduce((s,l)=>s+(parseFloat(l.hectareas)||0),0).toFixed(1)} ha · campaña <b>${esc(camp || '—')}</b></div>
    </div>
  `;

  const body = document.getElementById('pac-tl-body');
  // Línea HOY
  const hoyPct = (mesHoy - 0.5) / 12 * 100;
  body.innerHTML = `<div class="pac-tl-hoy-line" style="left:calc(160px + (100% - 160px) * ${hoyPct / 100})"><span class="pac-tl-hoy-label">HOY</span></div>`;

  // Filas
  for (const finca of fincas){
    const lotesFinca = byFinca[finca];
    body.insertAdjacentHTML('beforeend', `
      <div class="pac-tl-finca-row">
        <span class="pac-tl-finca-name">${esc(finca)}</span>
        <span class="pac-tl-finca-meta">${lotesFinca.length} lotes · ${lotesFinca.reduce((s,l)=>s+(parseFloat(l.hectareas)||0),0).toFixed(1)} ha</span>
      </div>
    `);

    for (const l of lotesFinca){
      const cult = getCultivoLote(l, camp);
      const cd = getCultivoData(l, camp);
      const isFiltered = STATE.filtroCultivo && cult !== STATE.filtroCultivo;
      const col = cult && window.cultColor ? cultColor(cult) : null;
      const isPerenne = isFrutal(cult);

      let barHTML = '';
      if (cult){
        const ms = cd?.mes_siembra || (isPerenne ? 1 : 9);
        const mc = cd?.mes_cosecha || (isPerenne ? 12 : 1);
        const segments = barSegments(ms, mc);
        const enDes = cd?.en_desarrollo;
        const prodPct = cd?.productividad_pct;
        for (let i = 0; i < segments.length; i++){
          const seg = segments[i];
          const startPct = ((seg.start - 1) / 12) * 100;
          const widthPct = ((seg.end - seg.start + 1) / 12) * 100;
          barHTML += `
            <div class="pac-tl-bar ${isPerenne ? 'perenne' : ''}"
              style="left:${startPct}%;width:${widthPct}%;background:${col.bg};border-color:${col.fg};color:${col.fg};${isPerenne ? `background-image:repeating-linear-gradient(45deg, ${col.fg}22 0 4px, transparent 4px 8px)` : ''}">
              ${i === 0 && widthPct > 8 ? `<span class="pac-tl-bar-label">${esc(cult)}${enDes ? `<span class="pac-tl-bar-dev">🌱 ${prodPct ? prodPct + '%' : 'desarr'}</span>` : ''}</span>` : ''}
            </div>
          `;
        }
      } else {
        barHTML = '<div class="pac-tl-empty">Sin asignar</div>';
      }

      body.insertAdjacentHTML('beforeend', `
        <div class="pac-tl-row" data-tl-lote-id="${l.id}" style="${isFiltered ? 'opacity:.3' : ''}">
          <div class="pac-tl-label" onclick="paEditarCultivo(${l.id},'${esc(l.nombre).replace(/'/g, "\\'")}')">
            <span class="pac-tl-nombre">${esc(l.nombre)}</span>
            <span class="pac-tl-ha-meta">${esc(l.hectareas)} ha${l.finca ? '' : ''}</span>
          </div>
          <div class="pac-tl-timeline">
            ${MES_NOMBRES.map((_, idx) => `<div class="pac-tl-grid ${idx % 3 === 0 ? 'trim' : ''}" style="left:calc(100% / 12 * ${idx})"></div>`).join('')}
            ${barHTML}
          </div>
        </div>
      `);
    }
  }

  // Click en barra → editar cultivo
  body.querySelectorAll('.pac-tl-bar').forEach((bar, idx) => {
    const row = bar.closest('[data-tl-lote-id]');
    if (!row) return;
    const id = parseInt(row.dataset.tlLoteId, 10);
    const lote = (PA.lotes || []).find(l => l.id === id);
    if (lote) bar.addEventListener('click', () => window.paEditarCultivo(id, lote.nombre));
  });
}

function barSegments(ms, mc){
  if (mc >= ms) return [{ start: ms, end: mc }];
  return [
    { start: ms, end: 12 },
    { start: 1, end: mc }
  ];
}

// ═════════ Bloque "Órdenes activas" en el modal de editar lote ═════════
function wrapEditarCultivo(){
  if (typeof window.paEditarCultivo !== 'function') {
    return setTimeout(wrapEditarCultivo, 200);
  }
  const orig = window.paEditarCultivo;
  window.paEditarCultivo = function(loteId, nombre){
    const r = orig.apply(this, arguments);
    setTimeout(() => injectOrdenesEnModal(loteId), 200);
    return r;
  };
  console.log('[pa-calendario] wrap de paEditarCultivo instalado');
}

function injectOrdenesEnModal(loteId){
  // Buscar el modal abierto (#pa-mb-cultivo)
  const modal = document.getElementById('pa-mb-cultivo');
  if (!modal || !modal.classList.contains('on')) return;

  // Si ya inyectamos, removerlo (puede ser otro lote)
  modal.querySelectorAll('.pac-modal-ordenes').forEach(el => el.remove());

  // Crear el bloque skeleton
  const block = document.createElement('div');
  block.className = 'pac-modal-ordenes';
  block.innerHTML = `
    <div class="pac-modal-ordenes-label">📋 Órdenes activas en este lote</div>
    <div class="pac-modal-ordenes-empty">Cargando…</div>
  `;
  // Insertar al final del body del modal — antes del footer si hay
  const notas = modal.querySelector('#pa-cult-edit-notas');
  if (notas && notas.parentNode) notas.parentNode.parentNode.insertBefore(block, notas.parentNode.nextSibling);
  else modal.querySelector('.mb-body, .modal-body')?.appendChild(block);

  // Buscar órdenes que mencionen este lote
  fetch('/api/pa/ordenes', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(res => {
      const data = res?.data || res?.ordenes || [];
      const activas = data.filter(o => {
        const lotes = o.lotes || o.lotes_ids || [];
        const estado = (o.estado || '').toLowerCase();
        const esActiva = estado === 'emitida' || estado === 'en_ejecucion' || estado === 'en ejecucion';
        if (!esActiva) return false;
        if (Array.isArray(lotes)) return lotes.includes(loteId) || lotes.some(x => x.id === loteId || x.lote_id === loteId);
        return false;
      });

      if (!activas.length){
        block.querySelector('.pac-modal-ordenes-empty').textContent = 'Este lote no tiene órdenes activas';
        return;
      }
      const hoy = new Date();
      block.querySelector('.pac-modal-ordenes-empty')?.remove();
      activas.forEach(o => {
        const dias = o.fecha_programada ? Math.round((new Date(o.fecha_programada) - hoy) / (86400000)) : null;
        const urgente = dias != null && dias <= 0;
        const item = document.createElement('div');
        item.className = 'pac-modal-orden-item';
        item.innerHTML = `
          <span class="pac-modal-orden-badge" style="background:${urgente ? '#F5DCDD' : '#F5E2B0'};color:${urgente ? '#8C1A1F' : '#8B6914'}">#${esc(o.numero_orden || o.id)}</span>
          <span class="pac-modal-orden-tipo">${esc(o.tipo || o.descripcion || 'Sin descripción')}</span>
          <span class="pac-modal-orden-dias ${urgente ? 'urgente' : ''}">${
            dias == null ? '—' : urgente ? 'Vence HOY' : `en ${dias}d`
          }</span>
        `;
        block.appendChild(item);
      });
    })
    .catch(e => {
      console.warn('[pa-calendario] No se pudieron cargar órdenes:', e);
      block.querySelector('.pac-modal-ordenes-empty').textContent = '— (no se pudieron cargar)';
    });
}

// ═════════ Helpers ═════════
function getCampanaActual(){
  const sel = document.getElementById('cal-campaña-sel');
  if (sel && sel.value) {
    const camp = (window.PA && PA.campañas || []).find(c => c.id == sel.value);
    return camp?.nombre || null;
  }
  const activa = (window.PA && PA.campañas || []).find(c => c.activa == 1);
  return activa?.nombre || null;
}

function getCultivoData(lote, campNom){
  if (!campNom || !lote.cultivos) return null;
  const cd = lote.cultivos[campNom];
  if (!cd) return null;
  return typeof cd === 'string' ? { cultivo: cd } : cd;
}

function getCultivoLote(lote, campNom){
  const cd = getCultivoData(lote, campNom);
  return cd?.cultivo || '';
}

function isFrutal(c){
  if (!c) return false;
  if (typeof window.esFrutal === 'function') return window.esFrutal(c);
  return /uva|durazno|damasco|ciruela|olivo|manzana|pera/i.test(c);
}

// ═════════ Init ═════════
function init(){
  if (STATE.inited) return;
  STATE.inited = true;
  wrapLoadCalendario();
  wrapEditarCultivo();
  console.log('[pa-calendario] módulo v2 cargado');
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose for debugging
window.PaCal2 = { STATE, renderTimeline, renderChipsKPI, injectMejoras };

})();
