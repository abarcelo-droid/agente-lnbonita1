/* ===========================================================================
   IFCO 2 — Módulo Cajones IFCO (San Gerónimo SA)
   Rediseño de alta fidelidad del handoff, cableado a la API real /api/ifco.
   Se monta dentro de #sec-ab-ifcos.ifco2 (la SPA del panel). Reusa los flujos de
   escritura existentes (window.ifcoAbrir*) — el rebuild de formularios es follow-up.
   Expone window.IFCO2.init() (lo llama loadSec('ab-ifcos')).
   =========================================================================== */
(function () {
  'use strict';
  var API = '/api/ifco';
  var st = { view: null, resumen: null, provNombre: {}, search: '00015-01', despEstado: '', soloSeguimiento: false };

  // ---------- helpers ----------
  function fetchJSON(url, opts) {
    return fetch(url, Object.assign({ credentials: 'include' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  function nf(n) { return (n == null || n === '') ? '—' : Number(n).toLocaleString('es-AR'); }
  function fdate(s) { if (!s) return '—'; var p = String(s).slice(0, 10).split('-'); return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : s; }
  function fdshort(s) { if (!s) return '—'; var p = String(s).slice(0, 10).split('-'); return p.length === 3 ? (p[2] + '/' + p[1]) : s; }
  function ic(n) { return '<i data-lucide="' + n + '"></i>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function diasDesde(f) { if (!f) return 0; var d = Math.floor((Date.now() - new Date(String(f).slice(0, 10)).getTime()) / 86400000); return (isNaN(d) || d < 0) ? 0 : d; }
  function cadenaCorta(c) { return String(c || '').replace(' (INC SA)', '').replace(' (DORINKA)', ''); }
  function inis(n) { n = String(n || '').trim(); if (!n) return '··'; return n.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase(); }
  function uav(name) { return '<span class="uav" title="' + esc(name || '') + '">' + inis(name) + '</span>'; }
  function toast(m, t) { if (typeof window.toast === 'function') window.toast(m, t); }
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }
  // Reusa un flujo legacy de IFCO REENVIANDO los argumentos (id/tipo/...). Antes llamaba
  // window[fn]() sin args, lo que rompía los handlers que esperan parámetro (ej.
  // ifcoConfirmarRecepcion(id), ifcoAbrirNuevoMovimiento(tipo)). Alineado con __ifco2Legacy.
  function reuse(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof window[fn] === 'function') { try { window[fn].apply(window, args); } catch (e) {} }
    else { toast('Acción disponible en el flujo actual', 'warn'); }
  }
  window.__ifco2Reuse = reuse;

  var ESTADO = {
    despachado: ['st-despachado', 'Despachado'], sellado: ['st-sellado', 'Sellado'],
    enviado: ['st-enviado', 'Enviado a IFCO'], presentado: ['st-presentado', 'Presentado'],
    anulado: ['st-anulado', 'Anulado'], en_viaje: ['st-enviaje', 'En viaje'],
    recibido: ['st-recibido', 'Recibido'], parcial: ['st-parcial', 'Parcial'],
    rechazado: ['st-rechazado', 'Rechazado'], retiro: ['st-retiro', 'Retiro'], perdida: ['st-perdida', 'Pérdida']
  };
  function badge(e) { var x = ESTADO[e] || ['st-anulado', e]; return '<span class="bg-badge ' + x[0] + '"><span class="d"></span>' + x[1] + '</span>'; }
  function diasChip(d, w, c) { w = w || 15; c = c || 25; var cls = d >= c ? 'crit' : (d >= w ? 'warn' : 'ok'); return '<span class="dias ' + cls + '">' + d + '&thinsp;d</span>'; }
  function provNombre(id) { return st.provNombre[id] || ('Proveedor #' + id); }
  function loading(msg) { return '<div style="padding:40px;text-align:center;color:var(--i-mut);font-size:13px">' + ic('loader') + ' ' + (msg || 'Cargando…') + '</div>'; }
  function empty(msg) { return '<div style="padding:34px;text-align:center;color:var(--i-sub);font-size:12.5px">' + esc(msg || 'Sin registros') + '</div>'; }

  // ---------- adapters (DB row -> shape de vista) ----------
  function mapRemito(r) {
    return {
      id: r.id, ifco: r.n_remito_ifco || '', sg: r.n_remito_sg || '', emi: r.fecha_emision,
      cadena: r.empresa || '', suc: r.sucursal || '', desp: r.cantidad_despachada,
      rec: (r.cantidad_recibida == null ? null : r.cantidad_recibida),
      rech: (r.cantidad_rechazada == null ? null : r.cantidad_rechazada),
      origen: r.origen || 'san_geronimo', prov: r.proveedor_origen_nombre || null,
      estado: r.estado, sell: r.fecha_sellado, env: r.fecha_enviado, pres: r.fecha_presentado,
      rdest: r.rechazo_destino, usuario: r.usuario_creador_nombre || '', dias: diasDesde(r.fecha_emision),
      seg: r.seguimiento ? 1 : 0, segNota: r.seguimiento_notas || '',
      fotoDesp: r.escaneo_original_path || '', fotoSell: r.escaneo_path || ''
    };
  }

  // =========================================================================
  // Navegación
  // =========================================================================
  var RENDER = {};
  function host(v) { return document.getElementById('iv-' + v); }
  function nav(v) {
    st.view = v;
    document.querySelectorAll('#sec-ab-ifcos .subnav button[data-v]').forEach(function (b) { b.classList.toggle('on', b.dataset.v === v); });
    document.querySelectorAll('#sec-ab-ifcos .view').forEach(function (s) { s.classList.toggle('on', s.id === 'iv-' + v); });
    var h = host(v);
    if (h && RENDER[v]) { h.innerHTML = loading(); icons(); Promise.resolve(RENDER[v](h)).then(icons); }
    window.scrollTo(0, 0);
  }
  window.__ifco2Nav = nav;

  // Refresca los pills del subnav (que solo se setean en init) leyendo /resumen y /recepciones-en-viaje.
  // Se usa en init y tras acciones que cambian datos por fuera de un nav() (p.ej. aplicar consolidación).
  function refreshPills() {
    fetchJSON(API + '/resumen').then(function (R) {
      st.resumen = R || {};
      var al = (R && R.alertas) || {};
      setPill('despachos', (al.urgentes_presentar || []).length, '');
      setPill('salidas', (al.envios_vencidos || []).length, 'amber');
      setPill('talonarios', al.talonario ? 1 : 0, 'amber');
    });
    fetchJSON(API + '/recepciones-en-viaje').then(function (v) { setPill('ingresos', (v && v.length) || 0, 'amber'); });
  }
  // Refresco completo de la vista nueva tras una acción legacy (la consolidación se aplica desde el
  // modal legacy): repinta los pills y re-renderiza la vista activa (cada RENDER re-fetchea de la API).
  window.__ifco2Refresh = function () { refreshPills(); if (st.view) nav(st.view); };

  function setPill(v, n, cls) {
    var b = document.querySelector('#sec-ab-ifcos .subnav button[data-v="' + v + '"]');
    if (!b) return;
    var old = b.querySelector('.pill'); if (old) old.remove();
    if (n && n > 0) {
      var s = document.createElement('span');
      s.className = 'pill' + (cls === 'amber' ? ' amber' : '');
      s.textContent = n;
      b.appendChild(s);
    }
  }

  // =========================================================================
  // 1) RESUMEN
  // =========================================================================
  RENDER.resumen = function (h) {
    return Promise.all([fetchJSON(API + '/resumen'), fetchJSON(API + '/stocks-reales')]).then(function (res) {
      var R = res[0] || {}, S = res[1] || {};
      var s = R.stock || {}, al = R.alertas || {}, sal = R.saldos || {};
      var conteos = (S.items || S || []);
      var sinContar = conteos.filter(function (c) { return c.falta_cargar; });

      function kpi(lbl, val, unit, icon, acc, sub) {
        return '<div class="kpi ' + (acc || '') + '"><div class="k-top"><div class="k-lbl">' + lbl + '</div><div class="k-ic">' + ic(icon) + '</div></div>'
          + '<div class="k-val">' + nf(val) + '<span class="u">' + unit + '</span></div><div class="k-sub">' + sub + '</div></div>';
      }

      var controles = [];
      var urg = (al.urgentes_presentar || []);
      if (urg.length) controles.push({ ai: 'crit', icon: 'alert-triangle', t: 'Sellados sin presentar a IFCO', s: urg.length + ' remitos · +25 días (multa en riesgo)', v: urg.reduce(function (a, x) { return a + (x.cantidad_recibida || 0); }, 0), u: 'cajones', go: 'despachos' });
      var env = (al.envios_vencidos || []);
      if (env.length) controles.push({ ai: 'warn', icon: 'send', t: 'Salidas a proveedor sin recepcionar', s: env.length + ' salidas · +15 días sin confirmar', v: env.reduce(function (a, x) { return a + (x.cantidad_enviada || 0); }, 0), u: 'cajones', go: 'salidas' });
      if (sinContar.length) controles.push({ ai: 'warn', icon: 'clipboard-list', t: 'Conteos físicos sin cargar', s: sinContar.map(function (c) { return c.nombre; }).slice(0, 3).join(' · '), v: sinContar.length, u: 'depósitos', go: 'conteo' });
      if (al.talonario) controles.push({ ai: 'crit', icon: 'book-marked', t: 'Talonario ' + (al.talonario.serie || '') + (al.talonario.razon === 'cai_vence' ? ' — CAI por vencer' : ' con pocos remitos'), s: (al.talonario.disponibles != null ? al.talonario.disponibles + ' disponibles' : '') + (al.talonario.dias_cai != null ? ' · CAI en ' + al.talonario.dias_cai + ' d' : ''), v: al.talonario.disponibles != null ? al.talonario.disponibles : '—', u: 'disp.', go: 'talonarios' });

      var controlesHtml = controles.length ? controles.map(function (a) {
        return '<div class="alert-row" onclick="__ifco2Nav(\'' + a.go + '\')"><div class="ai ' + a.ai + '">' + ic(a.icon) + '</div>'
          + '<div class="at"><b>' + esc(a.t) + '</b><span>' + esc(a.s) + '</span></div>'
          + '<div style="text-align:right"><div class="av tnum">' + nf(a.v) + '</div><div class="ac">' + a.u + '</div></div>' + ic('chevron-right') + '</div>';
      }).join('') : empty('Sin controles pendientes — todo al día');

      var provs = (sal.por_proveedor || []).filter(function (p) { return p.pendiente > 0; });
      var maxP = provs.reduce(function (m, p) { return Math.max(m, p.pendiente); }, 1);
      var provRows = provs.length ? provs.map(function (p) {
        var w = Math.round((p.pendiente / maxP) * 100);
        return '<tr><td class="lead">' + esc(p.proveedor_nombre) + '</td><td class="r num-strong">' + nf(p.pendiente) + '</td>'
          + '<td style="width:120px"><div class="mbar ' + (p.pendiente > maxP * 0.6 ? 'warn' : '') + '"><i style="width:' + w + '%"></i></div></td></tr>';
      }).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--i-sub);padding:18px">Sin saldos pendientes</td></tr>';

      var cads = (sal.por_cliente || []);
      var cadRows = cads.length ? cads.map(function (c) {
        return '<tr><td class="lead">' + esc(cadenaCorta(c.empresa || '')) + '</td><td class="r num-strong">' + nf(c.en_transito) + '</td>'
          + '<td class="c">' + (c.sellados_pendientes_count ? '<span class="tag">' + c.sellados_pendientes_count + ' p/sellar</span>' : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--i-sub);padding:18px">Sin cajones en tránsito</td></tr>';

      var tvTeo = conteos.reduce(function (a, c) { return a + (c.teorico || 0); }, 0);
      var tvReal = conteos.reduce(function (a, c) { return a + (c.real || 0); }, 0);

      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('gauge') + ' Resumen operativo</h2><div class="vh-sub">Posición de cajones IFCO y controles pendientes</div></div>'
        + '<div class="actions"><button class="btn btn-ghost btn-sm" onclick="__ifco2Nav(\'conteo\')">' + ic('clipboard-check') + ' Conteo físico</button></div></div>'
        + (sinContar.length ? '<div class="banner warn">' + ic('alert-triangle') + '<div><b>' + sinContar.length + ' conteos físicos sin cargar.</b> Todos los jueves a las 10:00 se pide el conteo de cada depósito para cuadrar el stock teórico contra el real.</div><button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="__ifco2Nav(\'conteo\')">Ir a conteo ' + ic('arrow-right') + '</button></div>' : '')
        + '<div class="kpis" style="grid-template-columns:repeat(6,1fr)">'
        + kpi('Piso San Gerónimo', s.piso, 'caj.', 'warehouse', '', 'en el piso de SG')
        + kpi('En proveedores', s.en_proveedores, 'caj.', 'factory', 'acc-slate', 'bajo responsabilidad ext.')
        + kpi('En tránsito a súper', s.en_transito, 'caj.', 'truck', 'acc-warn', 'despachados sin sellar')
        + kpi('Bajo responsabilidad', s.bajo_responsabilidad, 'caj.', 'shield-check', 'acc-gold', 'total a rendir a IFCO')
        + kpi('Pérdidas acumuladas', s.perdidas_acumuladas, 'caj.', 'alert-octagon', 'acc-err', 'multa asociada')
        + kpi('Retirado del pool', s.retirado_total, 'caj.', 'package', 'acc-ok', 'histórico total')
        + '</div>'
        + '<div class="split" style="margin-bottom:14px">'
        + '<div class="card"><div class="card-h"><h3>' + ic('list-checks') + ' Controles pendientes</h3>'
        + '<span class="tag" style="background:var(--i-err-bg);color:var(--i-err);border-color:var(--i-err-line)">' + controles.length + ' ítems</span></div>'
        + '<div class="alert-list">' + controlesHtml + '</div></div>'
        + '<div class="card"><div class="card-h"><h3>' + ic('scale') + ' Cuadre de stock</h3></div><div class="card-b">'
        + '<div class="istat" style="margin-bottom:14px"><div><div class="l">Teórico</div><div class="v tnum">' + nf(tvTeo) + '</div></div>'
        + '<div><div class="l">Real contado</div><div class="v tnum">' + nf(tvReal) + '</div></div>'
        + '<div><div class="l">Diferencia</div><div class="v tnum ' + (tvReal - tvTeo < 0 ? 'num-neg' : '') + '">' + (tvReal - tvTeo) + '</div></div></div>'
        + '<div class="sectlabel">Composición — bajo responsabilidad</div>'
        + [['Piso San Gerónimo', s.piso, 'var(--i-navy-600)'], ['En proveedores', s.en_proveedores, 'var(--i-slate)'], ['En tránsito a súper', s.en_transito, 'var(--i-warn)']].map(function (x) {
          var pct = s.bajo_responsabilidad ? Math.round((x[1] || 0) / s.bajo_responsabilidad * 100) : 0;
          return '<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><span style="font-size:12px;flex:1">' + x[0] + '</span>'
            + '<span class="tnum num-strong" style="font-size:12.5px">' + nf(x[1]) + '</span><div class="mbar" style="width:90px"><i style="width:' + pct + '%;background:' + x[2] + '"></i></div></div>';
        }).join('')
        + '<div style="border-top:1px solid var(--i-line);margin-top:10px;padding-top:10px;display:flex;justify-content:space-between;font-weight:700"><span>Total</span><span class="tnum">' + nf(s.bajo_responsabilidad) + '</span></div>'
        + '</div></div></div>'
        + '<div class="rowsplit">'
        + '<div class="card"><div class="card-h"><h3>' + ic('factory') + ' Saldos por proveedor</h3><span class="muted" style="font-size:11px">cajones sin devolver</span></div>'
        + '<div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Proveedor</th><th class="r">Pendiente</th><th></th></tr></thead><tbody>' + provRows + '</tbody></table></div></div></div>'
        + '<div class="card"><div class="card-h"><h3>' + ic('store') + ' Saldos por cadena</h3><span class="muted" style="font-size:11px">en tránsito / a sellar</span></div>'
        + '<div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Cadena</th><th class="r">En tránsito</th><th class="c">Pendiente</th></tr></thead><tbody>' + cadRows + '</tbody></table></div></div></div>'
        + '</div>';
    });
  };

  // =========================================================================
  // 2) DESPACHOS (estrella)
  // =========================================================================
  RENDER.despachos = function (h) {
    var qs = new URLSearchParams();
    if (st.search) qs.set('search', st.search);
    if (st.despEstado) qs.set('estado', st.despEstado);
    if (st.soloSeguimiento) qs.set('seguimiento', '1');
    return fetchJSON(API + '/remitos?' + qs.toString()).then(function (rows) {
      var R = (rows || []).map(mapRemito);
      var cnt = function (e) { return R.filter(function (r) { return r.estado === e; }).length; };
      var al = (st.resumen && st.resumen.alertas) || {};
      var sellTot = cnt('sellado');
      var urg = (al.urgentes_presentar || []).length;
      var enTransito = (st.resumen && st.resumen.stock && st.resumen.stock.en_transito) || R.filter(function (r) { return r.estado === 'despachado'; }).reduce(function (a, r) { return a + (r.desp || 0); }, 0);

      var segDefs = [['', 'Todos', R.length], ['despachado', 'Despachados', cnt('despachado')], ['sellado', 'Sellados', cnt('sellado')], ['enviado', 'Enviados', cnt('enviado')], ['presentado', 'Presentados', cnt('presentado')], ['anulado', 'Anulados', cnt('anulado')]];
      var segs = segDefs.map(function (s2) { return '<button class="' + (st.despEstado === s2[0] ? 'on' : '') + '" onclick="__ifco2Seg(\'' + s2[0] + '\')">' + s2[1] + '<span class="n">' + s2[2] + '</span></button>'; }).join('');
      // Toggle "Seguimiento" (filtra ?seguimiento=1). Cuenta = remitos marcados en la vista actual.
      var nSeg = R.filter(function (r) { return r.seg; }).length;
      segs += '<button class="' + (st.soloSeguimiento ? 'on' : '') + '" style="color:#b45309" onclick="__ifco2SegV(\'soloSeguimiento\',\'despachos\',' + (st.soloSeguimiento ? 'false' : 'true') + ')">🚩 Seguimiento<span class="n">' + nSeg + '</span></button>';

      var rowsHtml = R.length ? R.map(function (r) {
        var dchip = (r.estado === 'despachado') ? diasChip(r.dias, 15, 30) : (r.estado === 'sellado') ? diasChip(r.dias, 20, 25) : '<span class="dias ok">' + r.dias + '&thinsp;d</span>';
        var origenSub = r.origen === 'proveedor_directo' ? '<div class="sub2" style="color:var(--i-plum)">Directo · ' + esc(r.prov || '') + '</div>' : '';
        var cuadre = r.rec == null ? '<span class="cj-pend">sin sellar</span>'
          : (r.rech > 0 ? '<span class="cj-sub"><span class="cj-lbl">rec.</span> ' + nf(r.rec) + '<span class="cj-rech">−' + r.rech + '</span></span>'
            : '<span class="cj-sub"><span class="cj-lbl">rec.</span> ' + nf(r.rec) + '<i data-lucide="check" class="cj-ok"></i></span>');
        var act = (r.estado === 'despachado') ? '<button class="btn btn-gold btn-sm" onclick="event.stopPropagation();__ifco2Reuse(\'ifcoAbrirCargarSellado\')">' + ic('stamp') + ' Sellar</button>'
          : (r.estado === 'sellado') ? '<button class="btn btn-pri btn-sm" onclick="event.stopPropagation();__ifco2Open(' + r.id + ')">' + ic('send') + ' Enviar</button>' : '';
        var segTr = r.seg ? ' style="background:#fffbeb;box-shadow:inset 3px 0 0 #f59e0b"' : '';
        var segFlag = r.seg ? ' <span title="' + esc(r.segNota || 'En seguimiento') + '" style="cursor:help">🚩</span>' : '';
        var verFoto = (r.fotoSell || r.fotoDesp)
          ? '<button class="btn-icon btn-ghost" title="Ver foto" onclick="event.stopPropagation();__ifco2VerFoto(\'' + r.estado + '\',\'' + r.fotoSell + '\',\'' + r.fotoDesp + '\')">' + ic('image') + '</button>'
          : '';
        return '<tr data-rid="' + r.id + '"' + segTr + ' onclick="__ifco2Open(' + r.id + ')">'
          + '<td class="mono lead">' + esc((r.ifco.split('-')[1] || r.ifco)) + segFlag + '</td>'
          + '<td><div class="lead">' + esc(cadenaCorta(r.cadena)) + '</div>' + origenSub + '</td>'
          + '<td>' + fdate(r.emi) + '</td>'
          + '<td class="r"><div class="cj-cell"><span class="cj-desp">' + nf(r.desp) + '<span class="cj-u">desp.</span></span>' + cuadre + '</div></td>'
          + '<td><div style="display:flex;align-items:center;gap:8px">' + badge(r.estado) + dchip + '</div></td>'
          + '<td class="c">' + uav(r.usuario) + '</td>'
          + '<td><div class="rowact">' + act + verFoto + '<button class="btn-icon btn-ghost" onclick="__ifco2MenuDespacho(event,' + r.id + ',\'' + esc(r.ifco || '') + '\',\'' + (r.estado || '') + '\')">' + ic('more-horizontal') + '</button></div></td></tr>';
      }).join('') : '<tr><td colspan="7">' + empty('No hay remitos para este filtro/búsqueda') + '</td></tr>';

      var totDesp = R.filter(function (r) { return r.estado !== 'anulado'; }).reduce(function (a, r) { return a + (r.desp || 0); }, 0);
      var totRech = R.reduce(function (a, r) { return a + (r.rech || 0); }, 0);

      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('truck') + ' Despachos a súper</h2><div class="vh-sub">Remitos de cajones IFCO enviados a las cadenas · ciclo despachado → sellado → enviado → presentado</div></div>'
        + '<div class="actions"><button class="btn btn-ghost btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirCargarSellado\')">' + ic('scan-line') + ' Cargar sellado</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirPresentar\')">' + ic('send') + ' Presentar a IFCO</button>'
        + '<button class="btn btn-pri btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevoRemito\')">' + ic('plus') + ' Nuevo despacho</button></div></div>'
        + '<div class="kpis" style="grid-template-columns:1.5fr 1fr 1fr">'
        + '<div class="search-hero"><div class="sh-box">' + ic('search')
        + '<input id="ifco2-search" value="' + esc(st.search) + '" placeholder="Buscar N° de remito IFCO o SG, proveedor, cadena o sucursal…" onkeydown="if(event.key===\'Enter\')__ifco2Search(this.value)"><kbd>↵</kbd></div>'
        + '<div class="sh-hint">' + ic('info') + ' Buscá por número, cadena, sucursal o proveedor en todos los despachos</div></div>'
        + '<div class="kpi acc-gold"><div class="k-top"><div class="k-lbl">Sellados a presentar</div><div class="k-ic">' + ic('stamp') + '</div></div><div class="k-val">' + sellTot + '<span class="u">rem.</span></div><div class="k-sub"' + (urg ? ' style="color:var(--i-err)"' : '') + '>' + (urg ? ic('alert-triangle') + ' ' + urg + ' urgentes (+25 d)' : 'al día') + '</div></div>'
        + '<div class="kpi acc-warn"><div class="k-top"><div class="k-lbl">En tránsito (sin sellar)</div><div class="k-ic">' + ic('truck') + '</div></div><div class="k-val">' + nf(enTransito) + '<span class="u">caj.</span></div><div class="k-sub">' + ic('clock') + ' ' + cnt('despachado') + ' remitos abiertos</div></div>'
        + '</div>'
        + '<div class="filters"><div class="seg">' + segs + '</div>'
        + '<span class="chip-count"><b>' + R.length + '</b> remitos · <b>' + nf(totDesp) + '</b> caj. despachados · <b class="num-neg">' + totRech + '</b> rech.</span></div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr>'
        + '<th>N° IFCO</th><th>Cadena</th><th>Emisión</th><th class="r">Despacho · cuadre</th><th>Estado · antigüedad</th><th class="c">Usuario</th><th></th>'
        + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>'
        + '<div class="foot-note">' + ic('mouse-pointer-click') + ' Hacé click en un remito para abrir su trazabilidad. El sellado se carga desde la app móvil del operador o por foto del remito firmado (OCR).</div>';
    });
  };
  window.__ifco2Search = function (v) { st.search = (v || '').trim(); nav('despachos'); };
  window.__ifco2Seg = function (e) { st.despEstado = e; nav('despachos'); };
  // Filtro de segmentos genérico para las vistas que filtran client-side (retiros, ingresos,
  // salidas): guarda el valor en st[key] y re-renderiza la vista. Mismo patrón que __ifco2Seg.
  window.__ifco2SegV = function (key, view, val) { st[key] = val; nav(view); };

  function despDetalle(r) {
    var order = ['despachado', 'sellado', 'enviado', 'presentado'];
    var ci = order.indexOf(r.estado);
    var defs = [
      { l: 'Despachado', f: r.emi, x: nf(r.desp) + ' cajones · ' + (r.usuario || '') },
      { l: 'Sellado por el súper', f: r.sell, x: r.rec != null ? (nf(r.rec) + ' rec. / ' + (r.rech || 0) + ' rech.') : '' },
      { l: 'Enviado a IFCO', f: r.env, x: '' },
      { l: 'Presentado / confirmado', f: r.pres, x: '' }
    ];
    var steps = defs.map(function (d, i) {
      var stp = r.estado === 'anulado' ? 'pend' : (i < ci ? 'done' : (i === ci ? 'curr' : 'pend'));
      var dot = stp === 'done' ? ic('check') : (stp === 'curr' ? '<span class="dd"></span>' : '');
      var sub = d.f ? (fdate(d.f) + (d.x ? ' · ' + d.x : '')) : (i === ci ? 'en curso' : 'pendiente');
      return '<div class="tstep ' + stp + '"><div class="td">' + dot + '</div><div class="ti"><b>' + d.l + '</b><span>' + esc(sub) + '</span></div></div>';
    }).join('');
    var destino = r.rdest === 'proveedor' ? 'Proveedor de origen' : (r.rdest === 'san_geronimo' ? 'Piso San Gerónimo' : '—');
    var origen = r.origen === 'proveedor_directo' ? ('Directo · ' + (r.prov || '')) : 'San Gerónimo';
    var accion = { despachado: ic('stamp') + ' Registrar sellado', sellado: ic('send') + ' Presentar a IFCO', enviado: ic('clock') + ' Enviado — esperando IFCO', presentado: ic('check') + ' Cadena completa', anulado: ic('ban') + ' Remito anulado' }[r.estado] || '';
    // despachado → cargar sellado (app/OCR); SOLO sellado → flujo "Presentar a IFCO" (mail a ifco@).
    // 'enviado' ya no se re-envía (revertido #242): llega a presentado por la confirmación de IFCO.
    var accionFn = r.estado === 'despachado' ? 'ifcoAbrirCargarSellado' : (r.estado === 'sellado' ? 'ifcoAbrirPresentar' : null);
    var puedeAccion = !!accionFn;
    return '<div class="detail"><div class="d-head"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'
      + '<div><div class="dn">' + esc(r.ifco) + '</div><div class="dm">' + ic('store') + ' ' + esc(cadenaCorta(r.cadena)) + ' · ' + esc(r.suc) + '</div></div>'
      + '<button class="btn btn-icon" style="background:rgba(255,255,255,.14);color:#fff;border:0" onclick="__ifco2Close()">' + ic('x') + '</button></div></div>'
      + '<div style="padding:11px 16px;border-bottom:1px solid var(--i-line);display:flex;align-items:center;justify-content:space-between;gap:10px">' + badge(r.estado)
      + '<span class="dias ' + (r.dias >= 25 ? 'crit' : r.dias >= 15 ? 'warn' : 'ok') + '">Antigüedad: ' + r.dias + ' d</span></div>'
      + '<div class="dl">'
      + '<div class="di"><div class="l">N° remito SG</div><div class="v mono" style="font-size:12px">' + esc(r.sg || '—') + '</div></div>'
      + '<div class="di"><div class="l">Emisión</div><div class="v">' + fdate(r.emi) + '</div></div>'
      + '<div class="di"><div class="l">Despachado</div><div class="v big tnum">' + nf(r.desp) + '</div></div>'
      + '<div class="di"><div class="l">Recibido</div><div class="v big tnum">' + (r.rec != null ? nf(r.rec) : '—') + '</div></div>'
      + '<div class="di"><div class="l">Rechazado</div><div class="v big tnum ' + (r.rech ? 'num-neg' : '') + '">' + (r.rech != null ? r.rech : '—') + '</div></div>'
      + '<div class="di"><div class="l">Destino rechazo</div><div class="v" style="font-size:12px">' + (r.rech ? destino : '—') + '</div></div>'
      + '<div class="di"><div class="l">Origen</div><div class="v" style="font-size:12.5px">' + esc(origen) + '</div></div>'
      + '<div class="di"><div class="l">Cargado por</div><div class="v" style="font-size:12.5px;display:flex;align-items:center;gap:7px">' + uav(r.usuario) + ' ' + esc(r.usuario || '') + '</div></div>'
      + '</div>'
      + '<div style="padding:11px 16px 4px"><div class="sectlabel" style="margin-bottom:2px">Trazabilidad</div></div><div class="tline">' + steps + '</div>'
      + '<div class="card-b" style="border-top:1px solid var(--i-line);display:flex;gap:8px">'
      + (puedeAccion ? '<button class="btn btn-pri btn-sm" style="flex:1;justify-content:center" onclick="__ifco2Reuse(\'' + accionFn + '\')">' + accion + '</button>' : '<button class="btn btn-ghost btn-sm" style="flex:1;justify-content:center" disabled>' + accion + '</button>')
      + '<button class="btn btn-ghost btn-sm" onclick="__ifco2VerFoto(\'' + r.estado + '\',\'' + r.fotoSell + '\',\'' + r.fotoDesp + '\')">' + ic('image') + ' Ver foto</button></div></div>';
  }
  window.__ifco2Open = function (id) {
    fetchJSON(API + '/remitos/' + id).then(function (row) {
      if (!row) return;
      var r = mapRemito(row);
      document.querySelectorAll('#iv-despachos tbody tr.sel').forEach(function (t) { t.classList.remove('sel'); });
      var tr = document.querySelector('#iv-despachos tbody tr[data-rid="' + id + '"]'); if (tr) tr.classList.add('sel');
      var dw = document.getElementById('dwDespacho');
      dw.innerHTML = despDetalle(r); dw.classList.add('on'); dw.setAttribute('aria-hidden', 'false');
      document.getElementById('dwScrim').classList.add('on'); icons();
    });
  };
  // Visor de foto del remito (acceso directo desde la fila y el drawer). Muestra la foto
  // RELEVANTE según el estado (despachado → despacho; sellado/enviado/presentado → sellado)
  // con fallback a la que exista, y un toggle Despacho/Sellado solo si están ambas.
  window.__ifco2VerFoto = function (estado, sellPath, despPath) {
    sellPath = sellPath || ''; despPath = despPath || '';
    if (!sellPath && !despPath) { toast('Este remito no tiene fotos cargadas', 'warn'); return; }
    var ambas = !!(sellPath && despPath);
    var actual = (estado === 'despachado') ? (despPath ? 'desp' : 'sell') : (sellPath ? 'sell' : 'desp');
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px;font-family:var(--i-sans,sans-serif)';
    function render() {
      var src = actual === 'sell' ? sellPath : despPath;
      var toggle = ambas
        ? '<div style="display:inline-flex;gap:2px;background:rgba(255,255,255,.14);border-radius:8px;padding:3px">'
          + '<button data-k="desp" style="border:0;padding:6px 14px;border-radius:6px;font:inherit;font-size:13px;cursor:pointer;' + (actual === 'desp' ? 'background:#fff;color:#16202e' : 'background:transparent;color:#fff') + '">📷 Despacho</button>'
          + '<button data-k="sell" style="border:0;padding:6px 14px;border-radius:6px;font:inherit;font-size:13px;cursor:pointer;' + (actual === 'sell' ? 'background:#fff;color:#16202e' : 'background:transparent;color:#fff') + '">🔏 Sellado</button>'
          + '</div>'
        : '<div style="color:#cbd5e1;font-size:13px">' + (actual === 'sell' ? '🔏 Foto sellado' : '📷 Foto despacho') + '</div>';
      ov.innerHTML = '<div style="display:flex;align-items:center;gap:14px">' + toggle
        + '<button id="ifco2vf-close" title="Cerrar (Esc)" style="border:0;background:rgba(255,255,255,.15);color:#fff;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer">✕</button></div>'
        + '<img src="' + esc(src) + '" style="max-width:95%;max-height:82vh;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);background:#fff" alt="Foto remito">';
      ov.querySelector('#ifco2vf-close').onclick = close;
      Array.prototype.forEach.call(ov.querySelectorAll('button[data-k]'), function (b) {
        b.onclick = function (e) { e.stopPropagation(); actual = b.getAttribute('data-k'); render(); };
      });
    }
    function close() { if (ov.parentNode) ov.remove(); document.removeEventListener('keydown', onEsc, true); }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    ov.onclick = function (e) { if (e.target === ov) close(); };
    document.body.appendChild(ov);
    document.addEventListener('keydown', onEsc, true);
    render();
  };

  window.__ifco2Close = function () {
    var dw = document.getElementById('dwDespacho'); if (dw) { dw.classList.remove('on'); dw.setAttribute('aria-hidden', 'true'); }
    var sc = document.getElementById('dwScrim'); if (sc) sc.classList.remove('on');
    document.querySelectorAll('#iv-despachos tbody tr.sel').forEach(function (t) { t.classList.remove('sel'); });
  };

  // =========================================================================
  // 3) RETIROS / PÉRDIDAS
  // =========================================================================
  RENDER.retiros = function (h) {
    return Promise.all([fetchJSON(API + '/movimientos'), fetchJSON(API + '/autorizaciones-retiro')]).then(function (res) {
      var M = res[0] || [], AU = res[1] || [];
      var movFil = st.movFiltro || '';
      var Mf = movFil ? M.filter(function (m) { return m.tipo === movFil; }) : M;
      var rowsHtml = Mf.length ? Mf.map(function (m) {
        var consol = !!m.consolidado_en;
        return '<tr><td>' + fdate(m.fecha) + '</td><td>' + badge(m.tipo) + '</td>'
          + '<td class="r num-strong ' + (m.tipo === 'perdida' ? 'num-neg' : '') + '">' + (m.tipo === 'perdida' ? '−' : '+') + nf(m.cantidad) + '</td>'
          + '<td>' + esc(m.notas || m.n_remito || '—') + '</td>'
          + '<td>' + (consol ? '<span class="tag consol">' + ic('check') + ' consolidado</span>' : '<span class="tag" style="background:var(--i-warn-bg);color:var(--i-warn);border-color:var(--i-warn-line)">sin consolidar</span>') + '</td>'
          + '<td><div class="rowact">' + (consol ? '<button class="btn-icon btn-ghost" title="Bloqueado: consolidado">' + ic('lock') + '</button>' : '<button class="btn-icon btn-ghost" title="Editar" onclick="__ifco2Legacy(\'ifcoAbrirEditarMovimiento\',' + m.id + ')">' + ic('pencil') + '</button><button class="btn-icon btn-ghost" title="Eliminar" onclick="__ifco2SoftDelete(\'movimientos\',' + m.id + ',\'' + esc(m.n_remito || ('MOV-' + m.id)) + '\',\'retiros\')">' + ic('trash-2') + '</button>') + '</div></td></tr>';
      }).join('') : '<tr><td colspan="6">' + empty('Sin movimientos') + '</td></tr>';
      var retir = M.filter(function (m) { return m.tipo === 'retiro'; }).reduce(function (a, m) { return a + (m.cantidad || 0); }, 0);
      var perd = M.filter(function (m) { return m.tipo === 'perdida'; }).reduce(function (a, m) { return a + (m.cantidad || 0); }, 0);

      // Autorizaciones de retiro a IFCO (flujo de mail)
      var autBadge = function (e) {
        var map = { pendiente_envio: ['st-enviaje', 'Pendiente envío'], enviada: ['st-enviado', 'Enviada'], completada: ['st-presentado', 'Completada'], cancelada: ['st-anulado', 'Cancelada'] };
        var x = map[e] || ['st-anulado', e]; return '<span class="bg-badge ' + x[0] + '"><span class="d"></span>' + x[1] + '</span>';
      };
      var autRows = AU.length ? AU.map(function (a) {
        var acc;
        if (a.estado === 'pendiente_envio') acc = '<button class="btn btn-pri btn-sm" onclick="__ifco2AutorizEnviar(' + a.id + ')">' + ic('send') + ' Enviar</button><button class="btn btn-ghost btn-sm" onclick="__ifco2AutorizCompletar(' + a.id + ',' + (a.cantidad_estimada || 0) + ')">' + ic('clipboard-check') + ' Completar</button>';
        else if (a.estado === 'enviada') acc = '<button class="btn btn-ghost btn-sm" onclick="__ifco2AutorizCompletar(' + a.id + ',' + (a.cantidad_estimada || 0) + ')">' + ic('clipboard-check') + ' Completar</button>';
        else acc = '<span class="muted" style="font-size:11px">—</span>';
        return '<tr><td>' + fdate(a.fecha_autorizada) + '</td>'
          + '<td><div class="lead">' + esc(a.transportista_nombre) + '</div><div class="sub2">DNI ' + esc(a.transportista_dni) + ' · ' + esc(a.transportista_patente) + '</div></td>'
          + '<td class="r num-strong">' + nf(a.cantidad_estimada) + (a.cantidad_real != null ? '<div class="sub2">real ' + nf(a.cantidad_real) + '</div>' : '') + '</td>'
          + '<td>' + autBadge(a.estado) + '</td>'
          + '<td class="sub2">' + (a.mail_enviado_a ? esc(a.mail_enviado_a) : '<span class="muted">—</span>') + '</td>'
          + '<td><div class="rowact">' + acc + '</div></td></tr>';
      }).join('') : '<tr><td colspan="6">' + empty('Sin autorizaciones de retiro') + '</td></tr>';

      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('package-minus') + ' Retiros y pérdidas</h2><div class="vh-sub">Retiros del pool IFCO (altas de cajones vacíos) y pérdidas registradas</div></div>'
        + '<div class="actions"><button class="btn btn-ghost btn-sm" style="color:var(--i-err)" onclick="__ifco2Reuse(\'ifcoAbrirNuevoMovimiento\',\'perdida\')">' + ic('minus') + ' Registrar pérdida</button><button class="btn btn-ghost btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevoMovimiento\',\'retiro\')">' + ic('plus') + ' Registrar retiro</button><button class="btn btn-pri btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirAutorizacion\')">' + ic('mail') + ' Autorizar retiro a IFCO</button></div></div>'
        + '<div class="filters"><div class="seg">' + [['', 'Todos', M.length], ['retiro', 'Retiros', M.filter(function (m) { return m.tipo === 'retiro'; }).length], ['perdida', 'Pérdidas', M.filter(function (m) { return m.tipo === 'perdida'; }).length]].map(function (s) { return '<button class="' + (movFil === s[0] ? 'on' : '') + '" onclick="__ifco2SegV(\'movFiltro\',\'retiros\',\'' + s[0] + '\')">' + s[1] + '<span class="n">' + s[2] + '</span></button>'; }).join('') + '</div>'
        + '<span class="chip-count">Neto del mes: <b class="tnum">+' + nf(retir - perd) + '</b> cajones</span></div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Fecha</th><th>Tipo</th><th class="r">Cantidad</th><th>Detalle / OT</th><th>Consolidación</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>'
        + '<div class="foot-note">' + ic('lock') + ' Los movimientos consolidados quedan bloqueados: ya fueron verificados contra el archivo oficial de IFCO y no se pueden editar ni borrar.</div>'
        + '<div class="card" style="margin-top:16px"><div class="card-h"><h3>' + ic('mail') + ' Autorizaciones de retiro a IFCO</h3><span class="muted" style="font-size:11px">autorización al transportista · mail a ifco@lnbonita.com.ar</span></div>'
        + '<div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Fecha autorizada</th><th>Transportista</th><th class="r">Cantidad</th><th>Estado</th><th>Mail a</th><th></th></tr></thead><tbody>' + autRows + '</tbody></table></div></div></div>'
        + '<div class="foot-note">' + ic('info') + ' “Enviar” previsualiza y manda el mail de autorización a IFCO; “Completar” registra la cantidad real retirada + N° de remito (confirma el movimiento de stock). Cancelar/eliminar: follow-up.</div>';
    });
  };
  // Acciones del flujo "Autorizar retiro a IFCO" (lista en Retiros)
  window.__ifco2AutorizEnviar = function (id) {
    fetchJSON(API + '/autorizaciones-retiro/' + id + '/preview').then(function (p) {
      if (!p || p.error) { toast('No se pudo generar el preview del mail', 'er'); return; }
      if (!confirm('Enviar autorización de retiro a ifco@lnbonita.com.ar?\n\nAsunto: ' + p.asunto)) return;
      fetch(API + '/autorizaciones-retiro/' + id + '/enviar', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'ifco@lnbonita.com.ar', asunto: p.asunto, cuerpo_html: p.cuerpo_html, cuerpo_texto: p.cuerpo_texto }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.ok) { toast('✓ Autorización enviada a IFCO', 'ok'); nav('retiros'); } else { toast((d && d.error) || 'Error al enviar', 'er'); } })
        .catch(function () { toast('Error de red al enviar', 'er'); });
    });
  };
  window.__ifco2AutorizCompletar = function (id, estimada) {
    var cant = prompt('Cantidad REAL de cajones retirados:', estimada || '');
    if (cant === null) return;
    var n = parseInt(cant, 10); if (isNaN(n) || n < 0) { toast('Cantidad inválida', 'er'); return; }
    var rem = prompt('N° de remito IFCO del retiro:'); if (!rem || !String(rem).trim()) { toast('N° de remito requerido', 'er'); return; }
    fetch(API + '/autorizaciones-retiro/' + id + '/completar', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad_real: n, n_remito: String(rem).trim() }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { toast('✓ Retiro completado (' + d.cantidad_real + ' caj.)', 'ok'); nav('retiros'); } else { toast((d && d.error) || 'Error al completar', 'er'); } })
      .catch(function () { toast('Error de red al completar', 'er'); });
  };

  // =========================================================================
  // 4) TALONARIOS
  // =========================================================================
  RENDER.talonarios = function (h) {
    return fetchJSON(API + '/talonarios').then(function (rows) {
      var T = rows || [];
      var rowsHtml = T.length ? T.map(function (it) {
        var t = it.talonario || it;
        var total = (t.numero_hasta - t.numero_desde + 1) || 1;
        var usados = ((it.proximo_num || t.numero_desde) - t.numero_desde);
        var pct = Math.max(0, Math.min(100, Math.round(usados / total * 100)));
        var esSG = t.dueno_tipo === 'san_geronimo';
        var dueno = esSG ? 'San Gerónimo' : provNombre(t.proveedor_id);
        var caiCls = it.dias_cai == null ? 'ok' : (it.dias_cai < 0 ? 'crit' : (it.dias_cai < 60 ? 'warn' : 'ok'));
        var dispCls = it.disponibles === 0 ? 'crit' : (it.disponibles < 100 ? 'warn' : 'ok');
        return '<tr ' + (!t.activo ? 'style="opacity:.55"' : '') + '>'
          + '<td class="mono lead">' + esc(t.serie) + '</td>'
          + '<td>' + (esSG ? '<span class="tag gold">' + ic('building-2') + ' SG</span>' : '<span class="tag">' + ic('factory') + ' ' + esc(dueno) + '</span>') + '</td>'
          + '<td class="mono sub2">' + nf(t.numero_desde) + ' – ' + nf(t.numero_hasta) + '</td>'
          + '<td class="mono num-strong">' + (it.proximo_num != null ? nf(it.proximo_num) : '—') + '</td>'
          + '<td style="min-width:130px"><div style="display:flex;align-items:center;gap:8px"><div class="mbar ' + (pct > 90 ? 'warn' : '') + '" style="width:80px"><i style="width:' + pct + '%"></i></div><span class="sub2 tnum">' + pct + '%</span></div></td>'
          + '<td class="r"><span class="dias ' + dispCls + '">' + nf(it.disponibles) + '</span></td>'
          + '<td>' + fdate(t.vto_cai) + '</td>'
          + '<td class="c"><span class="dias ' + caiCls + '">' + (it.dias_cai == null ? '—' : (it.dias_cai < 0 ? 'vencido' : it.dias_cai + ' d')) + '</span></td>'
          + '<td>' + (t.activo && !it.agotado ? '<span class="bg-badge st-presentado"><span class="d"></span>Activo</span>' : '<span class="bg-badge st-anulado"><span class="d"></span>Agotado</span>') + '</td>'
          + '<td><div class="rowact"><button class="btn-icon btn-ghost" title="Transferir" onclick="__ifco2Legacy(\'ifcoAbrirTransferirTalonario\',' + t.id + ')">' + ic('arrow-right-left') + '</button><button class="btn-icon btn-ghost" onclick="__ifco2MenuTalonario(event,' + t.id + ',\'' + esc(t.serie || '') + '\')">' + ic('more-horizontal') + '</button></div></td></tr>';
      }).join('') : '<tr><td colspan="10">' + empty('Sin talonarios') + '</td></tr>';
      var alertaTal = T.filter(function (it) { return it.agotado || it.pocos_remitos || it.cai_alerta; });
      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('book-marked') + ' Talonarios</h2><div class="vh-sub">Numeración de remitos IFCO autorizada por AFIP (CAI) · por dueño</div></div>'
        + '<div class="actions"><button class="btn btn-pri btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevoTalonario\')">' + ic('plus') + ' Nuevo talonario</button></div></div>'
        + (alertaTal.length ? '<div class="banner warn">' + ic('alert-triangle') + '<div><b>' + alertaTal.length + ' talonario(s) con atención</b> — agotados, con pocos remitos o CAI por vencer. Gestioná la reposición con AFIP a tiempo.</div></div>' : '')
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Serie</th><th>Dueño</th><th>Rango</th><th>Próximo N°</th><th>Consumo</th><th class="r">Disp.</th><th>Vto. CAI</th><th class="c">Faltan</th><th>Estado</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>';
    });
  };

  // =========================================================================
  // 5) CONSOLIDACIÓN
  // =========================================================================
  RENDER.consolidacion = function (h) {
    h.innerHTML =
      '<div class="vh"><div><h2>' + ic('file-spreadsheet') + ' Consolidación</h2><div class="vh-sub">Verificación contra el archivo oficial de IFCO — los movimientos coincidentes quedan bloqueados</div></div></div>'
      + '<div class="split"><div class="card"><div class="card-b">'
      + '<div class="drop"><div class="di">' + ic('file-up') + '</div><b>Arrastrá el Excel de IFCO</b><div style="margin-top:4px;font-size:12px">.xlsx con los movimientos del período</div>'
      + '<button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="document.getElementById(\'ifco2-xlsx\').click()">' + ic('folder-open') + ' Elegir archivo</button>'
      + '<input type="file" id="ifco2-xlsx" accept=".xlsx" style="display:none" onchange="__ifco2Preview(this)"></div></div></div>'
      + '<div class="card"><div class="card-h"><h3>' + ic('git-compare-arrows') + ' Vista previa del cruce</h3></div>'
      + '<div class="card-b" id="ifco2-consol-preview">' + empty('Subí el Excel de IFCO para ver el cruce.') + '</div></div></div>'
      + '<div class="foot-note">' + ic('info') + ' “No está en sistema” = el archivo de IFCO tiene un movimiento que no figura cargado. Revisalo antes de consolidar para no dejar cajones sin rastrear.</div>';
    return Promise.resolve();
  };
  window.__ifco2Preview = function (input) {
    var f = input.files && input.files[0]; if (!f) return;
    var box = document.getElementById('ifco2-consol-preview');
    box.innerHTML = loading('Procesando ' + esc(f.name) + '…'); icons();
    var fd = new FormData(); fd.append('archivo', f);
    fetch(API + '/consolidar/preview', { method: 'POST', credentials: 'include', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.error) { box.innerHTML = empty('No se pudo procesar: ' + ((d && d.error) || 'error')); return; }
        // Guardamos el cruce para que "Abrir consolidación" salte directo a revisar/aplicar sin re-subir
        // el Excel (el modal legacy reusa este mismo objeto vía ifcoConsolidarDesdeCruce).
        window.__ifco2ConsolData = d;
        // OJO: el endpoint devuelve a_marcar/ya_consolidados/no_encontrados como ARRAYS de {archivo, sistema}
        // (no como conteos). Hay que mostrar su .length — concatenar el array crudo da "[object Object],…".
        function grp(lbl, g) { g = g || {};
          var a = (g.a_marcar || []).length, ya = (g.ya_consolidados || []).length, no = (g.no_encontrados || []).length;
          return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--i-line)"><span>' + lbl + '</span><span class="tnum"><b style="color:var(--i-ok)">' + a + '</b> · <span class="muted">' + ya + '</span> · <b style="color:var(--i-err)">' + no + '</b></span></div>'; }
        // Balance agregado (red de seguridad): total del archivo IFCO vs total del sistema, por lado.
        function bal(lbl, b) { b = b || {};
          var coincide = !!b.coincide;
          return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--i-line)"><span>' + lbl + '</span>'
            + '<span class="tnum">archivo <b>' + nf(b.total_archivo || 0) + '</b> · sistema <b>' + nf(b.total_sistema || 0) + '</b> · '
            + (coincide ? '<span class="tag consol">' + ic('check') + ' coincide</span>'
                        : '<b style="color:var(--i-err)">Δ ' + nf(b.diferencia || 0) + '</b>')
            + '</span></div>'; }
        box.innerHTML = '<div class="sectlabel">A consolidar · ya · no encontrados</div>' + grp('Despachos', d.despachos) + grp('Ingresos', d.ingresos) + grp('Altas R22', d.r22)
          + '<div class="sectlabel" style="margin-top:12px">Balance archivo vs sistema</div>' + bal('Egresos', d.balance_egresos) + bal('Ingresos', d.balance_ingresos)
          + '<button class="btn btn-pri btn-sm" style="margin-top:12px;width:100%;justify-content:center" onclick="__ifco2Legacy(\'ifcoConsolidarDesdeCruce\')">' + ic('check-check') + ' Abrir consolidación (revisar y aplicar)</button>';
        icons();
      }).catch(function () { box.innerHTML = empty('Error de red al procesar el archivo'); });
  };

  // =========================================================================
  // 6) INGRESOS (recepciones de proveedor)
  // =========================================================================
  RENDER.ingresos = function (h) {
    return fetchJSON(API + '/recepciones-proveedor').then(function (rows) {
      var R = rows || [];
      var ingFil = st.ingFiltro || '';
      var Rf = !ingFil ? R : R.filter(function (r) { return ingFil === 'r22' ? !!r.es_r22 : (r.estado === ingFil); });
      var rowsHtml = Rf.length ? Rf.map(function (r) {
        var estado = r.estado || 'recibido';
        var r22 = !!r.es_r22, consol = !!r.consolidado_en;
        var dias = diasDesde(r.fecha_recepcion);
        var quien = r22 ? '<span class="tag r22">R22</span> <span class="muted" style="font-size:11px">IFCO</span>' : '<span class="lead">' + esc(r.proveedor_nombre || '—') + '</span>';
        var dchip = estado === 'en_viaje' ? diasChip(dias, 2, 4) : '<span class="dias ok">' + dias + '&thinsp;d</span>';
        var conf = estado === 'recibido' ? '<div class="sub2">' + esc(r.usuario_creador_nombre || '') + '</div><div class="sub2 muted">' + fdshort(r.fecha_recepcion) + '</div>'
          : (estado === 'rechazado' ? '<div class="sub2 num-neg">' + esc(r.motivo_rechazo || 'Rechazado') + '</div>' : '<span class="muted">—</span>');
        var tipo = consol ? '<span class="tag consol">' + ic('check') + ' consolidado</span>' : (r22 ? '<span class="tag r22">stock IFCO</span>' : '<span class="muted" style="font-size:11px">producto</span>');
        var menuRec = '<button class="btn-icon btn-ghost" onclick="__ifco2MenuRecep(event,' + r.id + ',\'' + esc(r.n_remito_proveedor || '') + '\')">' + ic('more-horizontal') + '</button>';
        var act = estado === 'en_viaje' ? '<button class="btn btn-pri btn-sm" onclick="__ifco2ConfirmarRecep(' + r.id + ')">' + ic('check') + ' Confirmar</button><button class="btn btn-danger btn-sm" title="Rechazar" onclick="__ifco2RechazarRecep(' + r.id + ')">' + ic('x') + '</button>' + menuRec : menuRec;
        return '<tr ' + (estado === 'en_viaje' ? 'style="background:var(--i-navy-050)"' : '') + '>'
          + '<td class="mono">' + esc(r.n_remito_proveedor || '—') + '</td><td>' + quien + '</td><td>' + fdate(r.fecha_recepcion) + '</td>'
          + '<td class="r num-strong">' + nf(r.cantidad) + '</td><td>' + tipo + '</td><td>' + badge(estado) + '</td><td>' + conf + '</td><td class="c">' + dchip + '</td>'
          + '<td><div class="rowact">' + act + '</div></td></tr>';
      }).join('') : '<tr><td colspan="9">' + empty('Sin recepciones') + '</td></tr>';
      var enViaje = R.filter(function (r) { return r.estado === 'en_viaje'; });
      var totViaje = enViaje.reduce(function (a, r) { return a + (r.cantidad || 0); }, 0);
      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('log-in') + ' Ingresos de proveedor</h2><div class="vh-sub">Cajones que vuelven a San Gerónimo con producto, más altas R22 (cajones nuevos comprados a IFCO)</div></div>'
        + '<div class="actions"><button class="btn btn-ghost btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevaRecepcionR22\')">' + ic('plus') + ' Alta R22</button><button class="btn btn-pri btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevaRecepcionMerc\')">' + ic('plus') + ' Nueva recepción</button></div></div>'
        + (enViaje.length ? '<div class="banner info">' + ic('inbox') + '<div><b>' + enViaje.length + ' recepciones en viaje</b> esperando confirmación — <b class="tnum">' + nf(totViaje) + ' cajones</b>. Confirmá la recepción física para impactar el stock y descontar el saldo del proveedor.</div></div>' : '')
        + '<div class="filters"><div class="seg">' + [['', 'Todas', R.length], ['en_viaje', 'En viaje', enViaje.length], ['recibido', 'Recibidas', R.filter(function (r) { return r.estado === 'recibido'; }).length], ['r22', 'R22', R.filter(function (r) { return r.es_r22; }).length]].map(function (s) { return '<button class="' + (ingFil === s[0] ? 'on' : '') + '" onclick="__ifco2SegV(\'ingFiltro\',\'ingresos\',\'' + s[0] + '\')">' + s[1] + '<span class="n">' + s[2] + '</span></button>'; }).join('') + '</div>'
        + '<span class="chip-count"><b>' + R.length + '</b> recepciones</span></div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>N° remito</th><th>Proveedor / origen</th><th>Fecha</th><th class="r">Cajones</th><th>Tipo</th><th>Estado</th><th>Confirmación</th><th class="c">Antig.</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>';
    });
  };

  // =========================================================================
  // 7) SALIDAS (envíos a proveedor)
  // =========================================================================
  RENDER.salidas = function (h) {
    return fetchJSON(API + '/envios').then(function (rows) {
      var E = rows || [];
      var salFil = st.salFiltro || '';
      var Ef = salFil ? E.filter(function (e) { return e.estado === salFil; }) : E;
      // Aceptación digital del proveedor (link público con token): badge de estado por fila, para ver
      // de un vistazo qué galpones ya confirmaron la recepción aunque SG no la haya cargado a mano.
      function aceptBadge(e) {
        if (!e.aceptacion_token) return '';
        if (e.aceptado_en) return '<div class="sub2" style="color:var(--i-ok)" title="Aceptado por ' + esc(e.aceptado_por_nombre || '?') + ' · DNI ' + esc(e.aceptado_por_dni || '?') + ' · ' + fdshort(e.aceptado_en) + '">' + ic('check') + ' Aceptado</div>';
        if (e.visto_en)    return '<div class="sub2" style="color:var(--i-warn)" title="Abrió el link el ' + fdshort(e.visto_en) + ' pero todavía no confirmó">' + ic('eye') + ' Visto, sin confirmar</div>';
        return '<div class="sub2 muted">' + ic('clock') + ' Sin abrir</div>';
      }
      var rowsHtml = Ef.length ? Ef.map(function (e) {
        var env = e.cantidad_enviada || 0, rec = e.cantidad_recibida || 0, pend = env - rec;
        var occ = env ? Math.round(rec / env * 100) : 0;
        var dias = diasDesde(e.fecha_envio);
        var aceptado = !!e.aceptado_en;
        // Un envío aceptado por link ya no está "atrasado": la antigüedad no debe alarmar (rojo).
        var dchip = (e.estado === 'recibido' || aceptado) ? '<span class="dias ok">' + dias + '&thinsp;d</span>' : diasChip(dias, 10, 15);
        // Recepción: si hubo recepción manual mostramos el % de ocupación; si todavía no, pero el
        // proveedor ya aceptó por link, lo reflejamos como "aceptado digital" en vez de un 0% engañoso.
        var recepCell = (rec > 0 || e.estado === 'recibido' || e.estado === 'parcial')
          ? '<div style="display:flex;align-items:center;gap:8px"><div class="mbar ' + (occ === 100 ? 'ok' : (occ > 0 ? 'warn' : '')) + '" style="width:80px"><i style="width:' + occ + '%"></i></div><span class="sub2 tnum">' + occ + '%</span></div>'
          : (aceptado ? '<span class="tag consol">' + ic('check') + ' aceptado digital</span>'
                      : '<div style="display:flex;align-items:center;gap:8px"><div class="mbar" style="width:80px"><i style="width:0%"></i></div><span class="sub2 tnum">0%</span></div>');
        var linkBtn = e.aceptacion_token ? '<button class="btn btn-ghost btn-sm" title="Copiar link de aceptación para mandar al galpón por WhatsApp" onclick="__ifco2Legacy(\'ifcoCopiarLinkEnvio\',\'' + esc(e.n_remito_interno || '') + '\',\'' + esc(e.aceptacion_token) + '\')">' + ic('link') + ' Link</button>' : '';
        return '<tr><td class="mono lead">' + esc(e.n_remito_interno || '—') + '</td><td>' + fdate(e.fecha_envio) + '</td><td class="lead">' + esc(e.proveedor_nombre || '—') + '</td>'
          + '<td class="r num-strong">' + nf(env) + '</td><td class="r">' + nf(rec) + '</td><td class="r ' + (pend > 0 ? '' : 'muted') + '">' + (pend > 0 ? nf(pend) : '0') + '</td>'
          + '<td>' + recepCell + '</td>'
          + '<td>' + badge(e.estado) + '</td><td>' + (aceptBadge(e) || '<span class="muted">—</span>') + '</td><td class="c">' + dchip + '</td>'
          + '<td><div class="rowact">' + (e.estado !== 'recibido' ? '<button class="btn btn-pri btn-sm" onclick="__ifco2Legacy(\'ifcoAbrirRecepcion\',' + e.id + ')">' + ic('package-check') + ' Recepcionar</button>' : '') + linkBtn + '<button class="btn-icon btn-ghost" onclick="__ifco2MenuEnvio(event,' + e.id + ',\'' + esc(e.n_remito_interno || '') + '\')">' + ic('more-horizontal') + '</button></div></td></tr>';
      }).join('') : '<tr><td colspan="11">' + empty('Sin envíos') + '</td></tr>';
      var totEnv = E.reduce(function (a, e) { return a + (e.cantidad_enviada || 0); }, 0);
      var totRec = E.reduce(function (a, e) { return a + (e.cantidad_recibida || 0); }, 0);
      // "Atrasado" = enviado, +15 días, y NI recepcionado a mano NI aceptado por link. Sin el chequeo
      // de aceptado_en, los envíos que el galpón ya confirmó digitalmente aparecían como vencidos.
      var venc = E.filter(function (e) { return e.estado === 'enviado' && diasDesde(e.fecha_envio) >= 15 && !e.aceptado_en; });
      var aceptDigital = E.filter(function (e) { return e.aceptado_en && e.estado !== 'recibido'; }).length;
      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('log-out') + ' Salidas a proveedor</h2><div class="vh-sub">Cajones vacíos que San Gerónimo entrega a cada galpón (otros depósitos) para llenar con producto</div></div>'
        + '<div class="actions"><button class="btn btn-pri btn-sm" onclick="__ifco2Reuse(\'ifcoAbrirNuevoEnvio\')">' + ic('plus') + ' Nueva salida</button></div></div>'
        + (venc.length ? '<div class="banner warn">' + ic('clock') + '<div><b>' + venc.length + ' envíos sin recepcionar ni aceptar hace +15 días.</b> El proveedor debe confirmar la recepción (a mano o por el link) para que los cajones queden a su cargo.</div></div>' : '')
        + '<div class="filters"><div class="seg">' + [['', 'Todos', E.length], ['enviado', 'Enviados', E.filter(function (e) { return e.estado === 'enviado'; }).length], ['parcial', 'Parciales', E.filter(function (e) { return e.estado === 'parcial'; }).length], ['recibido', 'Recibidos', E.filter(function (e) { return e.estado === 'recibido'; }).length]].map(function (s) { return '<button class="' + (salFil === s[0] ? 'on' : '') + '" onclick="__ifco2SegV(\'salFiltro\',\'salidas\',\'' + s[0] + '\')">' + s[1] + '<span class="n">' + s[2] + '</span></button>'; }).join('') + '</div>'
        + '<span class="chip-count"><b>' + E.length + '</b> envíos · <b>' + nf(totEnv - totRec) + '</b> caj. pendientes' + (aceptDigital ? ' · <b style="color:var(--i-ok)">' + aceptDigital + '</b> aceptados por link' : '') + '</span></div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>N° envío</th><th>Fecha</th><th>Proveedor</th><th class="r">Enviado</th><th class="r">Recib.</th><th class="r">Pend.</th><th>Recepción</th><th>Estado</th><th>Aceptación</th><th class="c">Antig.</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody>'
        + '<tr class="totrow"><td colspan="3">Total</td><td class="r">' + nf(totEnv) + '</td><td class="r">' + nf(totRec) + '</td><td class="r">' + nf(totEnv - totRec) + '</td><td colspan="5"></td></tr></table></div></div></div>';
    });
  };

  // =========================================================================
  // 8) PAPELERA
  // =========================================================================
  RENDER.papelera = function (h) {
    return Promise.all([
      fetchJSON(API + '/remitos?papelera=1'), fetchJSON(API + '/envios?papelera=1'),
      fetchJSON(API + '/movimientos?papelera=1'), fetchJSON(API + '/recepciones-proveedor?papelera=1')
    ]).then(function (res) {
      var items = [];
      (res[0] || []).forEach(function (r) { items.push({ tipo: 'Despacho', ref: r.n_remito_ifco, det: cadenaCorta(r.empresa || '') + ' · ' + (r.sucursal || '') + ' · ' + nf(r.cantidad_despachada) + ' caj.', quien: r.eliminado_por_username, fecha: r.eliminado_en, motivo: r.notas || 'Eliminado', id: r.id, kind: 'remitos' }); });
      (res[1] || []).forEach(function (e) { items.push({ tipo: 'Salida', ref: e.n_remito_interno, det: (e.proveedor_nombre || '') + ' · ' + nf(e.cantidad_enviada) + ' caj.', quien: e.eliminado_por_username, fecha: e.eliminado_en, motivo: 'Eliminado', id: e.id, kind: 'envios' }); });
      (res[2] || []).forEach(function (m) { items.push({ tipo: 'Retiro', ref: m.n_remito || ('MOV-' + m.id), det: (m.notas || '') + ' · ' + nf(m.cantidad) + ' caj.', quien: m.eliminado_por_username, fecha: m.eliminado_en, motivo: 'Eliminado', id: m.id, kind: 'movimientos' }); });
      (res[3] || []).forEach(function (r) { items.push({ tipo: 'Ingreso', ref: r.n_remito_proveedor || ('REC-' + r.id), det: (r.proveedor_nombre || '') + ' · ' + nf(r.cantidad) + ' caj.', quien: r.eliminado_por_username, fecha: r.eliminado_en, motivo: 'Eliminado', id: r.id, kind: 'recepciones-proveedor' }); });
      items.sort(function (a, b) { return (b.fecha || '') < (a.fecha || '') ? -1 : 1; });
      var esAdmin = _esAdmin();
      var rowsHtml = items.length ? items.map(function (i) {
        return '<tr><td><span class="tag">' + i.tipo + '</span></td><td class="mono lead">' + esc(i.ref || '—') + '</td><td>' + esc(i.det) + '</td>'
          + '<td><span class="sub2 num-neg">' + esc(i.motivo) + '</span></td><td>' + esc(i.quien || '—') + '</td><td>' + fdate(i.fecha) + '</td>'
          + '<td><div class="rowact"><button class="btn btn-ghost btn-sm" onclick="__ifco2Restaurar(\'' + i.kind + '\',' + i.id + ')">' + ic('rotate-ccw') + ' Restaurar</button>'
          + (esAdmin ? '<button class="btn btn-danger btn-sm" onclick="__ifco2HardDelete(\'' + i.kind + '\',' + i.id + ',\'' + esc(i.ref || '') + '\')">' + ic('trash-2') + ' Eliminar definitivo</button>' : '')
          + '</div></td></tr>';
      }).join('') : '<tr><td colspan="7">' + empty('La papelera está vacía') + '</td></tr>';
      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('trash-2') + ' Papelera</h2><div class="vh-sub">Registros eliminados o anulados — se conservan 90 días y pueden restaurarse</div></div></div>'
        + '<div class="banner info">' + ic('info') + '<div>Nada se borra de forma definitiva sin pasar por acá. <b>Restaurar</b> devuelve el registro a su estado anterior; los movimientos ya consolidados no pueden eliminarse.</div></div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Tipo</th><th>Referencia</th><th>Detalle</th><th>Motivo</th><th>Eliminado por</th><th>Fecha</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>'
        + '<div class="foot-note">' + ic('clock') + ' Los registros se eliminan automáticamente de la papelera a los 90 días.</div>';
    });
  };
  window.__ifco2Restaurar = function (kind, id) {
    fetch(API + '/' + kind + '/' + id + '/restaurar', { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function () { toast('Registro restaurado', 'ok'); nav('papelera'); })
      .catch(function () { toast('No se pudo restaurar', 'er'); });
  };

  // =========================================================================
  // (drill-down) CONTEO FÍSICO — accesible desde Resumen, no es pestaña
  // =========================================================================
  RENDER.conteo = function (h) {
    return fetchJSON(API + '/stocks-reales').then(function (S) {
      var C = (S && (S.items || S)) || [];
      var rowsHtml = C.length ? C.map(function (c) {
        var dif = (c.diferencia != null) ? c.diferencia : (c.real != null ? c.real - c.teorico : null);
        var difTxt = c.real == null ? '<span class="tag" style="background:var(--i-warn-bg);color:var(--i-warn);border-color:var(--i-warn-line)">sin contar</span>'
          : '<span class="num-strong ' + (dif < 0 ? 'num-neg' : '') + '">' + (dif > 0 ? '+' : '') + dif + '</span>';
        var uc = c.ultimo_conteo || {};
        return '<tr ' + (c.falta_cargar ? 'style="background:var(--i-warn-bg)"' : '') + '>'
          + '<td class="lead">' + esc(c.nombre) + '</td>'
          + '<td>' + (c.deposito_tipo === 'san_geronimo' ? '<span class="tag gold">' + ic('building-2') + ' Propio</span>' : '<span class="tag">' + ic('factory') + ' Proveedor</span>') + '</td>'
          + '<td class="r num-strong">' + nf(c.teorico) + '</td><td class="r num-strong">' + (c.real != null ? nf(c.real) : '—') + '</td><td class="r">' + difTxt + '</td>'
          + '<td>' + (uc.fecha ? fdate(uc.fecha) : '<span class="muted">—</span>') + '</td>'
          + '<td>' + (c.falta_cargar ? '<span class="bg-badge st-enviaje"><span class="d"></span>' + (c.real == null ? 'Pendiente' : 'Atrasado') + '</span>' : '<span class="bg-badge st-presentado"><span class="d"></span>Al día</span>') + '</td>'
          + '<td><div class="rowact"><button class="btn btn-pri btn-sm" onclick="__ifco2Legacy(\'ifcoAbrirCargarStock\',\'' + c.deposito_tipo + '\',' + (c.proveedor_id || 'null') + ',\'' + esc(c.nombre).replace(/'/g, "\\'") + '\',' + (c.teorico || 0) + ')">' + ic('clipboard-pen') + ' Cargar conteo</button></div></td></tr>';
      }).join('') : '<tr><td colspan="8">' + empty('Sin depósitos') + '</td></tr>';
      var teo = C.reduce(function (a, c) { return a + (c.teorico || 0); }, 0);
      var real = C.reduce(function (a, c) { return a + (c.real || 0); }, 0);
      var sinContar = C.filter(function (c) { return c.falta_cargar; });
      h.innerHTML =
        '<div class="vh"><div><h2>' + ic('clipboard-check') + ' Conteo físico</h2><div class="vh-sub">Stock teórico contra el conteo real de cada depósito · se solicita los jueves a las 10:00</div></div>'
        + '<div class="actions"><button class="btn btn-ghost btn-sm" onclick="__ifco2Nav(\'resumen\')">' + ic('arrow-left') + ' Volver a Resumen</button></div></div>'
        + (sinContar.length ? '<div class="banner warn">' + ic('calendar-clock') + '<div><b>' + sinContar.length + ' depósitos sin contar esta semana.</b> La diferencia es informativa: no genera ajustes automáticos, pero es la base del control.</div></div>' : '')
        + '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">'
        + '<div class="kpi"><div class="k-top"><div class="k-lbl">Teórico total</div><div class="k-ic">' + ic('calculator') + '</div></div><div class="k-val">' + nf(teo) + '<span class="u">caj.</span></div><div class="k-sub">según sistema</div></div>'
        + '<div class="kpi acc-ok"><div class="k-top"><div class="k-lbl">Real contado</div><div class="k-ic">' + ic('clipboard-check') + '</div></div><div class="k-val">' + nf(real) + '<span class="u">caj.</span></div><div class="k-sub">' + C.filter(function (c) { return c.real != null; }).length + ' de ' + C.length + ' depósitos</div></div>'
        + '<div class="kpi acc-err"><div class="k-top"><div class="k-lbl">Diferencia</div><div class="k-ic">' + ic('scale') + '</div></div><div class="k-val ' + (real - teo < 0 ? 'num-neg' : '') + '">' + (real - teo) + '<span class="u">caj.</span></div><div class="k-sub">sobre lo contado</div></div>'
        + '<div class="kpi acc-warn"><div class="k-top"><div class="k-lbl">Sin contar</div><div class="k-ic">' + ic('clipboard-x') + '</div></div><div class="k-val">' + sinContar.length + '<span class="u">dep.</span></div><div class="k-sub">conteo atrasado</div></div>'
        + '</div>'
        + '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="dt"><thead><tr><th>Depósito</th><th>Tipo</th><th class="r">Teórico</th><th class="r">Real</th><th class="r">Dif.</th><th>Últ. conteo</th><th>Estado</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div></div>';
    });
  };

  // =========================================================================
  // Ayuda (drawer)
  // =========================================================================
  window.__ifco2Help = function (open) {
    var show = open !== false;
    var dw = document.getElementById('dwHelp'), sc = document.getElementById('helpScrim');
    if (dw) { dw.classList.toggle('on', show); dw.setAttribute('aria-hidden', show ? 'false' : 'true'); }
    if (sc) sc.classList.toggle('on', show);
    icons();
  };

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { window.__ifco2Close && window.__ifco2Close(); window.__ifco2Help && window.__ifco2Help(false); } });

  // =========================================================================
  // Menú ⋯ de fila + acciones (Editar / Eliminar soft / Hard delete admin)
  // =========================================================================
  function legacyCall(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof window[fn] === 'function') { try { window[fn].apply(window, args); } catch (e) { toast('Error: ' + (e.message || e), 'er'); } }
    else { toast('Acción no disponible', 'warn'); }
  }
  window.__ifco2Legacy = legacyCall;
  function _esAdmin() { return !!(window.LNB_USER && window.LNB_USER.rol === 'admin'); }

  window.__ifco2Menu = function (ev, items) {
    ev.stopPropagation();
    var prev = document.getElementById('ifco2-rowmenu'); if (prev) prev.remove();
    var m = document.createElement('div');
    m.id = 'ifco2-rowmenu';
    m.style.cssText = 'position:fixed;z-index:1300;background:#fff;border:1px solid #cfd8e3;border-radius:8px;box-shadow:0 4px 14px rgba(16,32,58,.18);padding:4px;min-width:172px;font-family:var(--i-sans,sans-serif);font-size:12.5px';
    var t = (ev.currentTarget || ev.target).getBoundingClientRect();
    m.style.top = (t.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(t.right - 172, window.innerWidth - 180)) + 'px';
    (items || []).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;padding:8px 10px;border-radius:6px;font:inherit;cursor:' + (it.disabled ? 'not-allowed' : 'pointer') + ';color:' + (it.danger ? '#b1271f' : '#16202e') + (it.disabled ? ';opacity:.45' : '');
      b.innerHTML = (it.icon ? '<i data-lucide="' + it.icon + '" style="width:15px;height:15px"></i>' : '') + '<span>' + esc(it.label) + '</span>';
      if (!it.disabled) {
        b.onmouseenter = function () { b.style.background = it.danger ? '#f9e1df' : '#eaf1f8'; };
        b.onmouseleave = function () { b.style.background = 'none'; };
      }
      b.onclick = function (e) { e.stopPropagation(); if (it.disabled) return; cerrar(); if (it.onClick) it.onClick(); };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    if (window.lucide) lucide.createIcons();
    function cerrar() { if (m.parentNode) m.remove(); document.removeEventListener('click', cerrar, true); document.removeEventListener('keydown', onEsc, true); }
    function onEsc(e) { if (e.key === 'Escape') cerrar(); }
    setTimeout(function () { document.addEventListener('click', cerrar, true); document.addEventListener('keydown', onEsc, true); }, 0);
  };

  // Soft-delete genérico (a papelera) + refresco de la vista nueva
  window.__ifco2SoftDelete = function (kind, id, ref, view) {
    if (!confirm('¿Eliminar ' + (ref || ('#' + id)) + '?\n\nVa a la Papelera y se puede restaurar.')) return;
    fetch(API + '/' + kind + '/' + id, { method: 'DELETE', credentials: 'include' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) toast(d.error, 'er'); else { toast('Eliminado (queda en Papelera)', 'ok'); nav(view); } })
      .catch(function () { toast('Error de red al eliminar', 'er'); });
  };

  // Confirmar / Rechazar recepción en viaje (Ingresos). Handlers NATIVOS de IFCO2: postean y
  // refrescan la vista nueva con nav('ingresos'). Antes se reusaba el handler legacy
  // (ifcoConfirmarRecepcion/ifcoRechazarRecepcion) que refresca la pane vieja oculta, no esta
  // vista → la fila quedaba mostrando "Confirmar" pese a haberse procesado (audit punto B, refresh).
  window.__ifco2ConfirmarRecep = function (id) {
    if (!confirm('¿Confirmar la recepción? Suma al stock de San Gerónimo y descuenta el saldo del proveedor.')) return;
    fetch(API + '/recepciones-proveedor/' + id + '/confirmar', { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) toast(d.error, 'er'); else { toast('Recepción confirmada', 'ok'); nav('ingresos'); } })
      .catch(function () { toast('Error de red al confirmar', 'er'); });
  };
  window.__ifco2RechazarRecep = function (id) {
    var motivo = prompt('Motivo del rechazo (opcional):', '');
    if (motivo === null) return;
    fetch(API + '/recepciones-proveedor/' + id + '/rechazar', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motivo: motivo || null })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) toast(d.error, 'er'); else { toast('Recepción rechazada', 'ok'); nav('ingresos'); } })
      .catch(function () { toast('Error de red al rechazar', 'er'); });
  };

  // Menús ⋯ por vista (reusan los handlers legacy para Editar)
  window.__ifco2MenuDespacho = function (ev, id, ref, estado) {
    __ifco2Menu(ev, [
      { label: 'Editar', icon: 'pencil', disabled: estado !== 'despachado', onClick: function () { legacyCall('ifcoAbrirEditarRemito', id); } },
      { label: 'Seguimiento', icon: 'flag', onClick: function () { __ifco2Seguimiento(id, ref); } },
      { label: 'Eliminar', icon: 'trash-2', danger: true, onClick: function () { __ifco2SoftDelete('remitos', id, ref, 'despachos'); } }
    ]);
  };

  // Modal de seguimiento: marca/desmarca un remito y guarda una nota (el por qué).
  // Funciona en cualquier estado. Prefilea con el detalle actual del remito.
  window.__ifco2Seguimiento = function (id, ref) {
    fetchJSON(API + '/remitos/' + id).then(function (r) {
      r = r || {};
      var marcado = !!r.seguimiento;
      var nota = r.seguimiento_notas || '';
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(11,29,51,.5);display:flex;align-items:center;justify-content:center;z-index:1400;padding:16px;font-family:var(--i-sans,sans-serif)';
      ov.innerHTML =
        '<div style="background:#fff;border-radius:12px;max-width:460px;width:100%;padding:22px;box-shadow:0 18px 50px rgba(11,29,51,.3)">'
        + '<div style="font-size:16px;font-weight:700;color:#16202e;margin-bottom:4px;display:flex;align-items:center;gap:8px">🚩 Seguimiento</div>'
        + '<div style="font-size:12.5px;color:#5b6b7f;margin-bottom:14px">Remito <b style="font-family:var(--i-mono,monospace)">' + esc(ref || ('#' + id)) + '</b> — marcalo si se complica (sellado u otra cuestión) y dejá el motivo.</div>'
        + '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer;margin-bottom:12px"><input type="checkbox" id="ifco2-seg-chk"' + (marcado ? ' checked' : '') + '> Marcar para seguimiento</label>'
        + '<textarea id="ifco2-seg-nota" rows="3" placeholder="Motivo / nota (opcional)" style="width:100%;padding:9px 11px;border:1.5px solid #cfd8e3;border-radius:8px;font-family:inherit;font-size:13.5px;box-sizing:border-box;resize:vertical">' + esc(nota) + '</textarea>'
        + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">'
        + '<button id="ifco2-seg-cancel" style="padding:9px 16px;border:1px solid #cfd8e3;background:#fff;border-radius:8px;cursor:pointer;font-size:13px">Cancelar</button>'
        + '<button id="ifco2-seg-ok" style="padding:9px 16px;border:0;background:#b45309;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Guardar</button>'
        + '</div></div>';
      document.body.appendChild(ov);
      if (window.lucide) lucide.createIcons();
      function close() { if (ov.parentNode) ov.remove(); }
      ov.querySelector('#ifco2-seg-cancel').onclick = close;
      ov.onclick = function (e) { if (e.target === ov) close(); };
      ov.querySelector('#ifco2-seg-ok').onclick = function () {
        var seg = ov.querySelector('#ifco2-seg-chk').checked ? 1 : 0;
        var notas = ov.querySelector('#ifco2-seg-nota').value;
        fetch(API + '/remitos/' + id + '/seguimiento', {
          method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seguimiento: seg, seguimiento_notas: notas })
        }).then(function (rp) { return rp.json().catch(function () { return {}; }); })
          .then(function (d) { close(); if (d && d.error) toast(d.error, 'er'); else { toast(seg ? 'Marcado para seguimiento' : 'Seguimiento quitado', 'ok'); nav('despachos'); } })
          .catch(function () { close(); toast('Error de red', 'er'); });
      };
      setTimeout(function () { var t = ov.querySelector('#ifco2-seg-nota'); if (t) t.focus(); }, 30);
    });
  };
  window.__ifco2MenuRecep = function (ev, id, ref) {
    __ifco2Menu(ev, [
      { label: 'Editar', icon: 'pencil', onClick: function () { legacyCall('ifcoAbrirEditarRecepcionMerc', id); } },
      { label: 'Eliminar', icon: 'trash-2', danger: true, onClick: function () { __ifco2SoftDelete('recepciones-proveedor', id, ref, 'ingresos'); } }
    ]);
  };
  window.__ifco2MenuEnvio = function (ev, id, ref) {
    __ifco2Menu(ev, [
      { label: 'Editar', icon: 'pencil', onClick: function () { legacyCall('ifcoAbrirEditarEnvio', id); } },
      { label: 'Eliminar', icon: 'trash-2', danger: true, onClick: function () { __ifco2SoftDelete('envios', id, ref, 'salidas'); } }
    ]);
  };
  window.__ifco2MenuTalonario = function (ev, id, serie) {
    // Talonarios: el "Eliminar" legacy es FÍSICO + admin (no tiene papelera). Se reusa tal cual.
    __ifco2Menu(ev, [
      { label: 'Editar', icon: 'pencil', onClick: function () { legacyCall('ifcoEditarTalonario', id); } },
      { label: 'Transferir', icon: 'arrow-right-left', onClick: function () { legacyCall('ifcoAbrirTransferirTalonario', id); } },
      { label: 'Eliminar (físico)', icon: 'trash-2', danger: true, onClick: function () { legacyCall('ifcoEliminarTalonario', id); } }
    ]);
  };

  // Hard delete (admin, desde Papelera) — confirmación ESCRIBIENDO la referencia
  window.__ifco2HardDelete = function (kind, id, ref) {
    if (!_esAdmin()) { toast('Solo un administrador puede eliminar definitivamente', 'er'); return; }
    var refStr = String(ref == null ? '' : ref).trim();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(11,29,51,.5);display:flex;align-items:center;justify-content:center;z-index:1400;padding:16px;font-family:var(--i-sans,sans-serif)';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:12px;max-width:470px;width:100%;padding:22px;box-shadow:0 18px 50px rgba(11,29,51,.3)">'
      + '<div style="font-size:17px;font-weight:700;color:#b1271f;margin-bottom:12px;display:flex;align-items:center;gap:8px"><i data-lucide="alert-triangle" style="width:18px;height:18px"></i> Eliminar definitivamente</div>'
      + '<div style="font-size:13.5px;line-height:1.55;color:#3f4d5e">Esto es <b>IRREVERSIBLE</b>: el registro se borra físicamente y <b>NO se puede restaurar</b> (queda solo un registro de auditoría de quién lo borró).<br><br>Para confirmar, escribí la referencia <b style="font-family:var(--i-mono,monospace)">' + esc(refStr) + '</b>:</div>'
      + '<input id="ifco2-hd-input" autocomplete="off" spellcheck="false" style="width:100%;margin-top:10px;padding:9px 11px;border:1.5px solid #cfd8e3;border-radius:8px;font-family:var(--i-mono,monospace);font-size:14px;box-sizing:border-box" placeholder="Escribí la referencia exacta">'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">'
      + '<button id="ifco2-hd-cancel" style="padding:9px 16px;border:1px solid #cfd8e3;background:#fff;border-radius:8px;cursor:pointer;font-size:13px">Cancelar</button>'
      + '<button id="ifco2-hd-ok" disabled style="padding:9px 16px;border:0;background:#b1271f;color:#fff;border-radius:8px;cursor:not-allowed;font-weight:600;font-size:13px;opacity:.5">Eliminar para siempre</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    if (window.lucide) lucide.createIcons();
    var inp = ov.querySelector('#ifco2-hd-input'), ok = ov.querySelector('#ifco2-hd-ok');
    function close() { if (ov.parentNode) ov.remove(); }
    inp.oninput = function () {
      var match = inp.value.trim() === refStr && refStr !== '';
      ok.disabled = !match; ok.style.opacity = match ? '1' : '.5'; ok.style.cursor = match ? 'pointer' : 'not-allowed';
    };
    ov.querySelector('#ifco2-hd-cancel').onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };
    ok.onclick = function () {
      if (ok.disabled) return;
      ok.disabled = true; ok.textContent = 'Eliminando…';
      fetch(API + '/papelera/eliminar-definitivo', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kind, id: id }) })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) { close(); if (d && d.ok) { toast('Eliminado definitivamente', 'ok'); nav('papelera'); } else { toast((d && d.error) || 'No se pudo eliminar', 'er'); } })
        .catch(function () { close(); toast('Error de red', 'er'); });
    };
    setTimeout(function () { inp.focus(); }, 30);
  };

  // =========================================================================
  // init
  // =========================================================================
  var _booted = false;
  window.IFCO2 = {
    init: function () {
      // catálogo de proveedores: mapa id->nombre (labels) Y el array crudo en IFCO._provs,
      // que los modales legacy reusados (nuevo/editar despacho, envío, recepción, R22,
      // transferir talonario) usan para poblar su <select> de proveedor. El rediseño dejó de
      // llamar ifcoCargar() que lo seteaba → quedaba vacío. OJO: IFCO es const global (no window.IFCO).
      fetchJSON(API + '/proveedores').then(function (ps) {
        (ps || []).forEach(function (p) { st.provNombre[p.id] = p.nombre; });
        try { if (typeof IFCO !== 'undefined' && IFCO) IFCO._provs = ps || []; } catch (e) {}
      });
      // Restaura el gate de prefill por foto (OCR). Los flujos legacy reusados (nuevo despacho,
      // cargar sellado, match-sellado) leen window-global IFCO._ocr, que seteaba ifcoCargar() —
      // el rediseño dejó de llamarlo. OJO: IFCO es un `const` global de panel.html (NO window.IFCO),
      // por eso se referencia por nombre con guarda typeof.
      fetchJSON(API + '/ocr/status').then(function (s) {
        try { if (typeof IFCO !== 'undefined' && IFCO) IFCO._ocr = s || { enabled: false }; } catch (e) {}
      });
      // resumen (KPIs + pills del subnav)
      refreshPills();
      // arranca SIEMPRE en Despachos con el buscador pre-cargado en 00015-01
      st.search = '00015-01'; st.despEstado = '';
      nav('despachos');
      _booted = true;
    }
  };
})();
