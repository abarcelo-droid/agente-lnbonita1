// ─── MÓDULO MANDATA ──────────────────────────────────────────
var MD = {
  deposito: '', empresa: '', clienteTel: '', clienteMetodoPago: '',
  items: [], partidas: [], clientes: [], metodoPago: ''
};

function mdFmt(n) {
  return n == null ? '—' : Number(n).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function mdTotalImporte() {
  return MD.items.reduce(function(s, i) { return s + i.bultos * (i.precio_bulto || 0); }, 0);
}

// ── Lista de mandatas ────────────────────────────────────────
function mdCargar() {
  var estado = (document.getElementById('md-filtro-estado') || {}).value || '';
  var dep    = (document.getElementById('md-filtro-dep')    || {}).value || '';
  var q = [estado ? 'estado='+estado : '', dep ? 'deposito='+encodeURIComponent(dep) : ''].filter(Boolean).join('&');
  abApi('/mandatas' + (q ? '?' + q : '')).then(function(res) {
    var cont = document.getElementById('md-lista');
    if (!res.ok || !res.data.length) {
      cont.innerHTML = '<div class="ab-empty"><div class="ab-empty-icon">🧾</div>Sin mandatas</div>';
      return;
    }
    cont.innerHTML = '';
    res.data.forEach(function(m) {
      var depColor = m.deposito==='MCBA' ? '#1e40af' : m.deposito==='FINCA' ? '#166534' : '#854d0e';
      var depBg    = m.deposito==='MCBA' ? '#dbeafe' : m.deposito==='FINCA' ? '#dcfce7' : '#fef9c3';
      var estColor = m.estado==='pendiente' ? '#854d0e' : m.estado==='facturada' ? '#166534' : '#991b1b';
      var estBg    = m.estado==='pendiente' ? '#fef9c3' : m.estado==='facturada' ? '#dcfce7' : '#fef2f2';
      var anulada  = m.estado === 'anulada';

      var card = document.createElement('div');
      card.style.cssText = 'background:var(--sur);border:1px solid var(--bor);border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.06)' + (anulada ? ';opacity:.5' : '');

      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
          '<div><div style="font-size:15px;font-weight:800;color:var(--burd)">' + m.nro_mandata + '</div>' +
          '<div style="font-size:12px;color:var(--mut);margin-top:1px">' + abFecha(m.fecha) + '</div></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' +
            '<span style="background:' + depBg + ';color:' + depColor + ';font-size:10px;font-weight:700;padding:3px 10px;border-radius:10px">' + m.deposito + '</span>' +
            '<span style="background:' + estBg + ';color:' + estColor + ';font-size:10px;font-weight:700;padding:3px 10px;border-radius:10px">' + m.estado.toUpperCase() + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:16px;font-weight:700;margin-bottom:6px">' + (m.empresa || '—') + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid var(--bor)">' +
          '<div style="font-size:12px;color:var(--mut)">' + (m.total_items || 0) + ' prod · ' + abFmt(m.total_kg) + ' kg</div>' +
          '<div style="font-size:18px;font-weight:900;color:var(--burd)">$' + mdFmt(m.total_importe) + '</div>' +
        '</div>';

      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;margin-top:10px';

      var btnVer = document.createElement('button');
      btnVer.className = 'btn bo bs';
      btnVer.style.cssText = 'flex:1;justify-content:center';
      btnVer.textContent = 'Ver';
      btnVer.addEventListener('click', function() { mdVerDetalle(m.id); });
      btns.appendChild(btnVer);

      var btnPdf = document.createElement('button');
      btnPdf.className = 'btn bb bs';
      btnPdf.textContent = '🖨';
      btnPdf.addEventListener('click', function() { window.open('/api/abasto/mandatas/' + m.id + '/pdf', '_blank'); });
      btns.appendChild(btnPdf);

      if (!anulada) {
        var btnAnular = document.createElement('button');
        btnAnular.className = 'btn bd bs';
        btnAnular.textContent = 'Anular';
        btnAnular.addEventListener('click', function() { mdAnular(m.id, m.nro_mandata); });
        btns.appendChild(btnAnular);
      }

      card.appendChild(btns);
      cont.appendChild(card);
    });
  });
}

// ── Abrir nueva mandata ──────────────────────────────────────
function mdAbrirNueva() {
  MD.deposito = ''; MD.empresa = ''; MD.clienteTel = '';
  MD.clienteMetodoPago = ''; MD.items = []; MD.partidas = [];
  MD.clientes = []; MD.metodoPago = '';

  var el;
  el = document.getElementById('md-prod-search'); if (el) el.value = '';
  el = document.getElementById('md-prod-list');   if (el) el.style.display = 'none';
  el = document.getElementById('md-cli-search');  if (el) el.value = '';
  el = document.getElementById('md-cli-lista');   if (el) el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--mut)">Escribí para buscar</div>';
  el = document.getElementById('md-cli-sel');     if (el) el.style.display = 'none';
  el = document.getElementById('md-header-info'); if (el) el.textContent = 'Comenzando...';
  el = document.getElementById('md-items-sel');   if (el) el.innerHTML = '';
  el = document.getElementById('md-items-edit');  if (el) el.innerHTML = '';
  el = document.getElementById('md-total-parcial'); if (el) el.style.display = 'none';
  el = document.getElementById('md-info-transferencia'); if (el) el.style.display = 'none';

  document.querySelectorAll('.md-pago-btn').forEach(function(b) {
    b.style.borderColor = 'var(--bor2)';
    b.style.background  = 'var(--sur)';
    b.style.color       = 'var(--txt)';
  });
  var btnConf = document.getElementById('md-btn-confirmar');
  if (btnConf) { btnConf.disabled = true; btnConf.style.opacity = '.4'; }

  // Pre-cargar clientes
  api('/api/clientes').then(function(cd) {
    MD.clientes = [];
    var v = {};
    (cd.data || cd || []).forEach(function(c) {
      var key = c.empresa || c.nombre || c.telefono;
      if (key && !v[key]) { v[key] = 1; MD.clientes.push(c); }
    });
  }).catch(function() {});

  // Depósitos del usuario
  var deps  = LNB_USER && LNB_USER.depositos ? LNB_USER.depositos : ['MCBA', 'FINCA', 'SAN PEDRO'];
  var emojis = { 'MCBA': '📦', 'FINCA': '🌿', 'SAN PEDRO': '🏙' };
  var descs  = { 'MCBA': 'Mercado Central Buenos Aires', 'FINCA': 'Depósito en finca', 'SAN PEDRO': 'Depósito San Pedro' };

  if (deps.length === 1) {
    MD.deposito = deps[0];
    el = document.getElementById('md-header-info');
    if (el) el.textContent = (emojis[deps[0]] || '📦') + ' ' + deps[0];
    mdMostrarPaso(2);
  } else {
    var lista = document.getElementById('md-dep-lista');
    if (lista) {
      lista.innerHTML = '';
      deps.forEach(function(dep) {
        var btn = document.createElement('button');
        btn.className = 'md-dep-btn';
        btn.dataset.dep = dep;
        btn.style.cssText = 'padding:22px 20px;border:2px solid var(--bor2);border-radius:14px;background:var(--sur);font-size:18px;font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:16px;transition:all .15s;box-shadow:0 2px 8px rgba(0,0,0,.06);width:100%';
        btn.innerHTML = '<span style="font-size:32px">' + (emojis[dep] || '📦') + '</span>' +
          '<div><div>' + dep + '</div><div style="font-size:12px;font-weight:400;color:var(--mut)">' + (descs[dep] || '') + '</div></div>';
        btn.addEventListener('click', function() { mdSelDepYSiguiente(this); });
        lista.appendChild(btn);
      });
    }
    mdMostrarPaso(1);
  }

  document.getElementById('md-modal-nueva').classList.add('on');
}

function mdMostrarPaso(n) {
  [1, 2, 3, 4, 5].forEach(function(i) {
    var el = document.getElementById('md-paso' + i);
    if (el) el.style.display = i === n ? 'block' : 'none';
  });
  var pcts = { 1: '20%', 2: '40%', 3: '60%', 4: '80%', 5: '100%' };
  var prog = document.getElementById('md-progress');
  if (prog) prog.style.width = pcts[n] || '20%';
}

function mdVolver(n) { mdMostrarPaso(n); }

function mdSelDepYSiguiente(btn) {
  MD.deposito = btn.getAttribute('data-dep');
  var el = document.getElementById('md-header-info');
  if (el) el.textContent = '📦 ' + MD.deposito;
  var back2 = document.getElementById('md-back2');
  if (back2) back2.style.display = 'flex';
  mdMostrarPaso(2);
}

// ── Paso 2: cliente ──────────────────────────────────────────
function mdFiltrarClientes(q) {
  var lista = document.getElementById('md-cli-lista');
  if (!q || q.length < 1) {
    lista.innerHTML = '<div style="text-align:center;padding:32px;color:var(--mut)">Escribí para buscar</div>';
    return;
  }
  var filtrados = MD.clientes.filter(function(c) {
    var key = c.empresa || c.nombre || c.telefono || '';
    return key.toLowerCase().indexOf(q.toLowerCase()) >= 0;
  }).slice(0, 12);

  lista.innerHTML = '';

  if (!filtrados.length) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:16px;border:2px dashed var(--bor2);border-radius:12px;cursor:pointer;text-align:center;color:var(--mut)';
    div.innerHTML = '<div style="font-size:14px;font-weight:600;color:var(--txt)">"' + q + '"</div><div style="font-size:12px;margin-top:4px">Usar este nombre →</div>';
    div.addEventListener('click', function() { mdSelCliente(q.trim()); });
    lista.appendChild(div);
    return;
  }

  filtrados.forEach(function(c) {
    var nombre = c.empresa || c.nombre || c.telefono || '';
    var tel    = c.telefono || '';
    var metodo = c.metodo_pago || '';
    var div = document.createElement('div');
    div.style.cssText = 'padding:18px 16px;background:var(--sur);border:1px solid var(--bor);border-radius:12px;cursor:pointer;font-size:16px;font-weight:600;transition:all .12s;box-shadow:0 1px 4px rgba(0,0,0,.05);margin-bottom:6px';
    div.innerHTML = nombre + (metodo === 'cta_cte' ? ' <span style="font-size:10px;background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:8px;font-weight:700">CTA CTE</span>' : '');
    div.addEventListener('mouseenter', function() { this.style.borderColor = 'var(--burg)'; this.style.background = 'var(--burl)'; });
    div.addEventListener('mouseleave', function() { this.style.borderColor = 'var(--bor)';  this.style.background = 'var(--sur)'; });
    div.addEventListener('click', function() { mdSelClienteObj({ nombre: nombre, tel: tel, metodo: metodo }); });
    lista.appendChild(div);
  });
}

function mdSelClienteObj(obj) {
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch(e) { return; } }
  MD.empresa           = obj.nombre;
  MD.clienteTel        = obj.tel    || '';
  MD.clienteMetodoPago = obj.metodo || '';
  var el;
  el = document.getElementById('md-cli-sel-nombre'); if (el) el.textContent  = obj.nombre;
  el = document.getElementById('md-cli-sel');        if (el) el.style.display = 'block';
  el = document.getElementById('md-cli-lista');      if (el) el.innerHTML     = '';
  el = document.getElementById('md-cli-search');     if (el) el.value         = obj.nombre;
  var btnCta = document.getElementById('md-btn-cta-cte');
  if (btnCta) btnCta.style.opacity = obj.metodo === 'cta_cte' ? '1' : '.4';
}

function mdSelCliente(nombre) {
  mdSelClienteObj({ nombre: nombre, tel: '', metodo: '' });
}

function mdLimpiarCliente() {
  MD.empresa = ''; MD.clienteTel = ''; MD.clienteMetodoPago = '';
  var el;
  el = document.getElementById('md-cli-sel');    if (el) el.style.display = 'none';
  el = document.getElementById('md-cli-search'); if (el) el.value = '';
  el = document.getElementById('md-cli-lista');  if (el) el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--mut)">Escribí para buscar</div>';
}

// ── Paso 3: productos ────────────────────────────────────────
function mdIrPaso3() {
  if (!MD.empresa) { toast('Seleccioná un cliente', 'er'); return; }
  var el;
  el = document.getElementById('md-header-info');  if (el) el.textContent = '📦 ' + MD.deposito + ' · ' + MD.empresa;
  el = document.getElementById('md-paso3-cliente'); if (el) el.textContent = MD.empresa;
  el = document.getElementById('md-paso3-dep');     if (el) el.textContent = MD.deposito;
  abApi('/partidas?estado=activa&deposito=' + encodeURIComponent(MD.deposito)).then(function(res) {
    MD.partidas = res.ok ? res.data : [];
    mdRenderItemsSel();
    mdMostrarPaso(3);
  });
  mdCargarDestacados();
}

function mdCargarDestacados() {
  abApi('/mandata/destacados').then(function(res) {
    var grid = document.getElementById('md-destacados');
    if (!res.ok || !res.data.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:12px;color:var(--mut);font-size:12px">Sin productos destacados configurados</div>';
      return;
    }
    grid.innerHTML = '';
    res.data.forEach(function(rp) {
      var partida  = MD.partidas.find(function(p) { return (p.producto_display || p.producto || '').toLowerCase().indexOf((rp.nombre || '').toLowerCase()) >= 0; });
      var stock    = partida ? partida.bultos_disponibles : 0;
      var disabled = stock === 0;

      var btn = document.createElement('button');
      btn.style.cssText = 'padding:16px 12px;border:2px solid ' + (disabled ? 'var(--bor)' : 'var(--bor2)') + ';border-radius:14px;background:' + (disabled ? 'var(--bg)' : 'var(--sur)') + ';cursor:' + (disabled ? 'default' : 'pointer') + ';text-align:center;transition:all .15s;opacity:' + (disabled ? '.4' : '1');
      btn.innerHTML =
        '<div style="font-size:22px;margin-bottom:4px">📦</div>' +
        '<div style="font-size:13px;font-weight:700;color:var(--txt);line-height:1.2">' + rp.nombre + '</div>' +
        '<div style="font-size:11px;color:var(--mut);margin-top:4px">' + (disabled ? 'Sin stock' : stock + ' bultos') + '</div>' +
        (rp.precio_minorista_mcba ? '<div style="font-size:12px;font-weight:700;color:var(--burd);margin-top:4px">$' + mdFmt(rp.precio_minorista_mcba) + '/bto</div>' : '');

      if (!disabled) {
        btn.addEventListener('mouseenter', function() { this.style.borderColor = 'var(--burg)'; this.style.background = 'var(--burl)'; });
        btn.addEventListener('mouseleave', function() { this.style.borderColor = 'var(--bor2)'; this.style.background = 'var(--sur)'; });
        btn.addEventListener('click', function() { mdAgregarDestacado(rp.id, rp.nombre); });
      }
      grid.appendChild(btn);
    });
  });
}

function mdAgregarDestacado(rpId, nombre) {
  var partida = MD.partidas.find(function(p) { return (p.producto_display || p.producto || '').toLowerCase().indexOf(nombre.toLowerCase()) >= 0; });
  if (!partida) { toast('Sin stock disponible para ' + nombre, 'er'); return; }
  if (MD.items.find(function(i) { return i.partida_id === partida.id; })) { toast('Ya está en la lista', 'er'); return; }
  abApi('/mandata/precio?nombre=' + encodeURIComponent(nombre)).then(function(res) {
    var precio = res.ok && res.data ? (res.data.precio_minorista_mcba || 0) : 0;
    MD.items.push({ partida_id: partida.id, producto: partida.producto, producto_display: partida.producto_display || partida.producto, bultos: 1, kilos_por_bulto: partida.kilos_por_bulto, disponible: partida.bultos_disponibles, precio_bulto: precio });
    mdRenderItemsSel();
    toast(nombre + ' agregado', 'ok');
  });
}

function mdFiltrarPartidas(q) {
  var list = document.getElementById('md-prod-list');
  if (!q) { list.style.display = 'none'; return; }
  var disp = MD.partidas.filter(function(p) {
    return p.bultos_disponibles > 0 &&
      (p.producto_display || p.producto || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
  });
  if (!disp.length) { list.style.display = 'none'; return; }

  list.innerHTML = '';
  disp.forEach(function(p) {
    var nombre = p.producto_display || p.producto || '—';
    var div = document.createElement('div');
    div.style.cssText = 'padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--bor);display:flex;justify-content:space-between;align-items:center;background:var(--sur)';
    div.innerHTML =
      '<div><div style="font-weight:700;font-size:15px">' + nombre + '</div>' +
      '<div style="font-size:11px;color:var(--mut);margin-top:2px">' + (p.proveedor_nombre || '—') + ' · ' + p.kilos_por_bulto + ' kg/bulto</div></div>' +
      '<div style="text-align:right;flex-shrink:0;margin-left:12px">' +
        '<div style="font-weight:900;font-size:16px;color:var(--burd)">' + p.bultos_disponibles + '</div>' +
        '<div style="font-size:10px;color:var(--mut)">bultos</div></div>';
    div.addEventListener('mouseenter', function() { this.style.background = 'var(--burl)'; });
    div.addEventListener('mouseleave', function() { this.style.background = 'var(--sur)'; });
    div.addEventListener('click', function() { mdAgregarProducto(p.id); });
    list.appendChild(div);
  });
  list.style.display = 'block';
}

function mdAgregarProducto(id) {
  var p = MD.partidas.find(function(x) { return x.id === id; });
  if (!p) return;
  if (MD.items.find(function(i) { return i.partida_id === id; })) { toast('Ya está en la lista', 'er'); return; }
  var nombre = p.producto_display || p.producto || '';
  abApi('/mandata/precio?nombre=' + encodeURIComponent(nombre)).then(function(res) {
    var precio = res.ok && res.data ? (res.data.precio_minorista_mcba || 0) : 0;
    MD.items.push({ partida_id: p.id, producto: p.producto, producto_display: nombre, bultos: 1, kilos_por_bulto: p.kilos_por_bulto, disponible: p.bultos_disponibles, precio_bulto: precio });
    var el = document.getElementById('md-prod-search'); if (el) el.value = '';
    var list = document.getElementById('md-prod-list'); if (list) list.style.display = 'none';
    mdRenderItemsSel();
  });
}

function mdRenderItemsSel() {
  var cont   = document.getElementById('md-items-sel');
  var btnSig = document.getElementById('md-btn-paso4');
  var totDiv = document.getElementById('md-total-parcial');

  if (!MD.items.length) {
    cont.innerHTML = '<div style="text-align:center;padding:28px;color:var(--mut);font-size:14px">Tocá un producto para agregarlo</div>';
    if (btnSig) { btnSig.disabled = true; btnSig.style.opacity = '.4'; }
    if (totDiv) totDiv.style.display = 'none';
    return;
  }
  var totKg = 0, totImp = 0;
  cont.innerHTML = '';
  MD.items.forEach(function(item, i) {
    var kg  = item.bultos * item.kilos_por_bulto;
    var imp = item.bultos * (item.precio_bulto || 0);
    totKg += kg; totImp += imp;

    var card = document.createElement('div');
    card.style.cssText = 'background:var(--sur);border:1px solid var(--bor);border-radius:12px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    card.innerHTML =
      '<div><div style="font-weight:700;font-size:14px">' + item.producto_display + '</div>' +
      '<div style="font-size:12px;color:var(--mut)">' + item.bultos + ' bultos · ' + kg.toFixed(1) + ' kg</div></div>';

    var btnQ = document.createElement('button');
    btnQ.style.cssText = 'background:none;border:none;color:var(--err);font-size:20px;cursor:pointer;padding:4px 8px';
    btnQ.textContent = '×';
    btnQ.addEventListener('click', (function(idx) { return function() { mdQuitarItem(idx); }; })(i));
    card.appendChild(btnQ);
    cont.appendChild(card);
  });

  var el;
  el = document.getElementById('md-tot-kg');  if (el) el.textContent = totKg.toFixed(1) + ' kg';
  el = document.getElementById('md-tot-imp'); if (el) el.textContent = '$' + mdFmt(totImp);
  if (totDiv) totDiv.style.display = 'block';
  if (btnSig) { btnSig.disabled = false; btnSig.style.opacity = '1'; }
}

function mdQuitarItem(i) { MD.items.splice(i, 1); mdRenderItemsSel(); }

// ── Paso 4: cantidades y precios ─────────────────────────────
function mdIrPaso4() {
  if (!MD.items.length) { toast('Agregá al menos un producto', 'er'); return; }
  mdRenderItemsEdit();
  mdMostrarPaso(4);
}

function mdRenderItemsEdit() {
  var cont = document.getElementById('md-items-edit');
  cont.innerHTML = '';

  MD.items.forEach(function(item, i) {
    var card = document.createElement('div');
    card.id = 'md-edit-' + i;
    card.style.cssText = 'background:var(--sur);border:1px solid var(--bor);border-radius:16px;padding:16px;margin-bottom:14px';

    var titulo = document.createElement('div');
    titulo.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:14px;color:var(--txt)';
    titulo.textContent = item.producto_display;
    card.appendChild(titulo);

    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:14px';

    // Columna bultos
    var colB = document.createElement('div');
    var lblB = document.createElement('div');
    lblB.style.cssText = 'font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px';
    lblB.textContent = 'Bultos (máx ' + item.disponible + ')';
    colB.appendChild(lblB);

    var rowB = document.createElement('div');
    rowB.style.cssText = 'display:flex;align-items:center;gap:8px';

    var btnM = document.createElement('button');
    btnM.style.cssText = 'width:44px;height:44px;border:2px solid var(--bor2);border-radius:10px;background:var(--bg);font-size:22px;cursor:pointer;line-height:1;flex-shrink:0';
    btnM.textContent = '−';
    btnM.addEventListener('click', (function(idx) { return function() { mdCambiarBultos(idx, -1); }; })(i));

    var inpB = document.createElement('input');
    inpB.type = 'number'; inpB.inputMode = 'numeric';
    inpB.min = 1; inpB.max = item.disponible; inpB.value = item.bultos;
    inpB.id = 'md-bultos-' + i;
    inpB.style.cssText = 'flex:1;padding:10px;border:2px solid var(--bor2);border-radius:10px;font-size:22px;font-weight:800;text-align:center;font-family:var(--sans);outline:none;min-width:0';
    inpB.addEventListener('focus',  function() { this.style.borderColor = 'var(--burg)'; });
    inpB.addEventListener('blur',   function() { this.style.borderColor = 'var(--bor2)'; });
    inpB.addEventListener('input',  (function(idx) { return function() { mdActualizarItem(idx, 'bultos', this.value); }; })(i));
    inpB.addEventListener('change', (function(idx) { return function() { mdActualizarItem(idx, 'bultos', this.value); }; })(i));

    var btnP = document.createElement('button');
    btnP.style.cssText = 'width:44px;height:44px;border:2px solid var(--burg);border-radius:10px;background:var(--burg);color:#fff;font-size:22px;cursor:pointer;line-height:1;flex-shrink:0';
    btnP.textContent = '+';
    btnP.addEventListener('click', (function(idx) { return function() { mdCambiarBultos(idx, 1); }; })(i));

    rowB.appendChild(btnM); rowB.appendChild(inpB); rowB.appendChild(btnP);
    colB.appendChild(rowB);

    // Columna precio
    var colP = document.createElement('div');
    var lblPW = document.createElement('div');
    lblPW.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px';
    var lblP = document.createElement('div');
    lblP.style.cssText = 'font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em';
    lblP.textContent = '$ / Bulto';
    lblPW.appendChild(lblP);
    if (item.precio_bulto) {
      var lblSug = document.createElement('div');
      lblSug.style.cssText = 'font-size:10px;color:var(--ok);font-weight:600';
      lblSug.textContent = '✓ precio sugerido';
      lblPW.appendChild(lblSug);
    }
    colP.appendChild(lblPW);

    var inpP = document.createElement('input');
    inpP.type = 'number'; inpP.inputMode = 'decimal';
    inpP.min = 0; inpP.step = 0.01; inpP.value = item.precio_bulto || ''; inpP.placeholder = '0.00';
    inpP.id = 'md-precio-' + i;
    inpP.style.cssText = 'width:100%;padding:10px;border:2px solid var(--bor2);border-radius:10px;font-size:22px;font-weight:800;text-align:center;font-family:var(--sans);outline:none;box-sizing:border-box';
    inpP.addEventListener('focus',  function() { this.style.borderColor = 'var(--burg)'; });
    inpP.addEventListener('blur',   function() { this.style.borderColor = 'var(--bor2)'; });
    inpP.addEventListener('input',  (function(idx) { return function() { mdActualizarItem(idx, 'precio_bulto', this.value); }; })(i));
    inpP.addEventListener('change', (function(idx) { return function() { mdActualizarItem(idx, 'precio_bulto', this.value); }; })(i));
    colP.appendChild(inpP);

    grid.appendChild(colB); grid.appendChild(colP);
    card.appendChild(grid);

    // Subtotal
    var sub = document.createElement('div');
    sub.style.cssText = 'display:flex;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--bor);font-size:14px';
    sub.innerHTML = '<span style="color:var(--mut)">' + (item.bultos * item.kilos_por_bulto).toFixed(1) + ' kg</span>' +
      '<span style="font-weight:800;font-size:16px;color:var(--burd)" id="md-imp-' + i + '">$' + mdFmt(item.bultos * (item.precio_bulto || 0)) + '</span>';
    card.appendChild(sub);
    cont.appendChild(card);
  });

  mdActualizarTotalPaso4();
}

function mdCambiarBultos(i, delta) {
  var item = MD.items[i];
  var nuevo = Math.min(Math.max(1, item.bultos + delta), item.disponible);
  MD.items[i].bultos = nuevo;
  var inp = document.getElementById('md-bultos-' + i);
  if (inp) inp.value = nuevo;
  mdActualizarImpItem(i);
  mdActualizarTotalPaso4();
}

function mdActualizarItem(i, campo, val) {
  var v = campo === 'bultos' ? Math.min(Math.max(1, parseInt(val) || 1), MD.items[i].disponible) : (parseFloat(val) || 0);
  MD.items[i][campo] = v;
  mdActualizarImpItem(i);
  mdActualizarTotalPaso4();
}

function mdActualizarImpItem(i) {
  var item = MD.items[i];
  var imp  = item.bultos * (item.precio_bulto || 0);
  var el   = document.getElementById('md-imp-' + i);
  if (el) el.textContent = '$' + mdFmt(imp);
}

function mdActualizarTotalPaso4() {
  var tot = mdTotalImporte();
  var el  = document.getElementById('md-tot-imp2');
  if (el) el.textContent = '$' + mdFmt(tot);
}

// ── Paso 5: forma de pago ────────────────────────────────────
function mdIrPaso5() {
  var tot = mdTotalImporte();
  var el;
  el = document.getElementById('md-tot-pago');    if (el) el.textContent = '$' + mdFmt(tot);
  el = document.getElementById('md-pago-cliente'); if (el) el.textContent = MD.empresa;
  mdMostrarPaso(5);
}

function mdSelPago(btn) {
  var pago = btn.getAttribute('data-pago');
  if (pago === 'cta_cte' && MD.clienteMetodoPago !== 'cta_cte') {
    toast('Este cliente no tiene Cta. Cte. habilitada', 'er'); return;
  }
  document.querySelectorAll('.md-pago-btn').forEach(function(b) {
    b.style.borderColor = 'var(--bor2)'; b.style.background = 'var(--sur)'; b.style.color = 'var(--txt)';
  });
  btn.style.borderColor = 'var(--burg)'; btn.style.background = 'var(--burl)'; btn.style.color = 'var(--burd)';
  MD.metodoPago = pago;
  var infoTrans = document.getElementById('md-info-transferencia');
  if (infoTrans) infoTrans.style.display = pago === 'transferencia' ? 'block' : 'none';
  var btnConf = document.getElementById('md-btn-confirmar');
  if (btnConf) { btnConf.disabled = false; btnConf.style.opacity = '1'; }
}

// ── Confirmar y emitir ───────────────────────────────────────
function mdConfirmar() {
  if (!MD.metodoPago) { toast('Seleccioná forma de pago', 'er'); return; }
  var body = {
    fecha: new Date().toISOString().split('T')[0],
    deposito: MD.deposito,
    empresa: MD.empresa,
    cliente_telefono: MD.clienteTel || null,
    metodo_pago: MD.metodoPago,
    items: MD.items.map(function(i) {
      return { partida_id: i.partida_id, bultos: i.bultos, kilos_por_bulto: i.kilos_por_bulto, precio_kg: 0, precio_bulto: i.precio_bulto || 0 };
    })
  };
  var btn = document.getElementById('md-btn-confirmar');
  btn.disabled = true; btn.textContent = 'Emitiendo...';

  abApi('/mandatas', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
    if (!res.ok) {
      toast('Error: ' + res.error, 'er');
      btn.disabled = false; btn.textContent = '✓ Emitir mandata';
      return;
    }

    // WhatsApp al cliente
    if (MD.clienteTel) {
      var tel = MD.clienteTel.replace(/\D/g, '');
      if (tel.indexOf('54') !== 0) tel = '54' + tel;
      var tot   = mdTotalImporte();
      var items = MD.items.map(function(it) { return '%E2%80%A2 ' + encodeURIComponent(it.producto_display) + ' x' + it.bultos + ' bultos'; }).join('%0A');
      var msg   = encodeURIComponent('🧾 Vale de retiro — ' + res.nro_mandata) +
        '%0ACliente: ' + encodeURIComponent(MD.empresa) +
        '%0A%0A' + items +
        '%0A%0ATotal: $' + encodeURIComponent(mdFmt(tot)) +
        '%0APago: ' + encodeURIComponent(MD.metodoPago.toUpperCase()) +
        '%0A%0A_La Ni%C3%B1a Bonita — San Ger%C3%B3nimo SA_%0ANave 4 · Puesto 2-4-6 · Mercado Central';
      window.open('https://wa.me/' + tel + '?text=' + msg, '_blank');
    }

    // Caja del operador si es efectivo
    if (MD.metodoPago === 'efectivo' && LNB_USER) {
      abApi('/caja', { method: 'POST', body: JSON.stringify({
        usuario_id: LNB_USER.id,
        mandata_id: res.id,
        concepto: 'Mandata ' + res.nro_mandata + ' — ' + MD.empresa,
        tipo: 'ingreso',
        monto: mdTotalImporte(),
        metodo_pago: 'efectivo'
      })}).catch(function() {});
    }

    abCerrarModal('md-modal-nueva');
    toast('✓ Mandata ' + res.nro_mandata + ' emitida', 'ok');
    mdCargar(); abDashboard();
  });
}

function mdAnular(id, nro) {
  if (!confirm('¿Anular la mandata ' + nro + '?\nEl stock vuelve al depósito.')) return;
  abApi('/mandatas/' + id + '/anular', { method: 'POST', body: '{}' }).then(function(res) {
    if (res.ok) { toast('Mandata anulada — stock devuelto', 'ok'); mdCargar(); abDashboard(); }
    else toast('Error: ' + res.error, 'er');
  });
}

function mdVerDetalle(id) {
  abApi('/mandatas/' + id).then(function(res) {
    if (!res.ok) return;
    var m     = res.data;
    var items = (m.items || []).map(function(i) {
      return '• ' + (i.producto_display || i.producto) + ' — ' + i.bultos + ' bultos · ' + i.kilos_total.toFixed(1) + ' kg = $' + mdFmt(i.importe);
    }).join('\n');
    alert(m.nro_mandata + ' — ' + m.empresa + '\n' + abFecha(m.fecha) + ' | ' + m.deposito + '\n\n' + items + '\n\n─────\nTotal: $' + mdFmt(m.total_importe) + (m.metodo_pago ? '\nPago: ' + m.metodo_pago : ''));
  });
}
