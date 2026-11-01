// src/servicios/galponResumenExcel.js
// ── EL RESUMEN DE LA TEMPORADA, EN PLANILLA ─────────────────────────────────────────
// Andy, 1/11/2026: «quiero que en acumulado se pueda descargar un archivo como el que te
// saco foto».
//
// La foto es la planilla que ya llevan a mano: una fila por día, y en el medio la
// producción abierta POR PRESENTACIÓN con sus bultos y sus kilos. A los costados, el
// ingreso (lo volcado) y las dos columnas de descarte y verde, pintadas.
//
// ── LAS COLUMNAS SALEN DE LOS DATOS, NO DE UNA LISTA ────────────────────────────────
// La planilla de papel tiene las presentaciones escritas a mano en el encabezado
// —Cartón, Ifcos, Ifcos HN, wenco—, y el día que agreguen una quinta hay que rehacer la
// planilla. Acá las columnas se arman con las presentaciones que APARECEN en el período:
// una presentación nueva trae su par de columnas sola, y una que no se usó no ocupa
// lugar.
//
// ── Y POR QUÉ ExcelJS Y NO xlsx ─────────────────────────────────────────────────────
// Por los colores. La planilla de papel pinta el descarte en rojo y el verde en verde, y
// eso no es decoración: es cómo se lee de un vistazo cuál fue un mal día. `xlsx` escribe
// los números pero no los pinta. ExcelJS ya es lo que usa el resto del repo
// (servicios/ordenExcel.js).
//
// Se importa A DEMANDA desde el router, igual que en el resto del repo: así los tests
// que no tienen node_modules no se caen al cargar el módulo.

// Los colores de la planilla de papel, y los mismos tres destinos de la pantalla.
const COL = {
  ingreso: 'FFE8DCC0',     // el beige del bloque INGRESO
  produccion: 'FFF2F2F2',
  descarte: 'FFE06C6C',
  verde: 'FF9BD39B',
  cabecera: 'FF1A3A5C',
  total: 'FFDDE3EA',
};

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* Las presentaciones que aparecieron en el período, en el orden en que las lista el
   catálogo. Dos pares de columnas por cada una —bultos y kilos—, que es exactamente lo
   que tiene la planilla a mano. */
export function columnasDelResumen(filas) {
  const vistas = new Map();
  for (const f of filas) {
    for (const p of f.presentaciones || []) {
      if (!vistas.has(p.nombre)) vistas.set(p.nombre, { nombre: p.nombre, orden: p.orden });
    }
  }
  return [...vistas.values()].sort((a, b) => (a.orden - b.orden)
    || (a.nombre < b.nombre ? -1 : 1));
}

export async function galponResumenExcel(ExcelJS, datos) {
  const { filas, desde, hasta } = datos;
  const cols = columnasDelResumen(filas);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'La Niña Bonita · Galpón';
  const ws = wb.addWorksheet('Resumen', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }],
  });

  // ── FILA 1: los bloques ───────────────────────────────────────────────────
  // Tres columnas de ingreso, dos por presentación, tres de total, dos de descarte y
  // dos de verde. Se calculan y no se escriben a mano: con una presentación nueva, un
  // encabezado fijo quedaría corrido una columna y NADIE lo vería — los números
  // seguirían cayendo abajo de un título equivocado.
  const iIngreso = 1;              // Fecha, Cant, kg
  const iProd = iIngreso + 3;
  const iTotal = iProd + cols.length * 2;   // Total bultos, Total kg, %
  const iDesc = iTotal + 3;        // Cant, kg
  const iVerde = iDesc + 2;        // Cant, kg
  const ancho = iVerde + 2 - 1;

  const banda = (desdeCol, hastaCol, texto, color) => {
    if (hastaCol < desdeCol) return;
    ws.mergeCells(1, desdeCol, 1, hastaCol);
    const c = ws.getCell(1, desdeCol);
    c.value = texto;
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.font = { bold: true, size: 12 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  };
  banda(iIngreso, iIngreso + 2, 'INGRESO', COL.ingreso);
  banda(iProd, iTotal + 2, 'PRODUCCIÓN', COL.produccion);
  banda(iDesc, iDesc + 1, 'CAJ DESCARTE', COL.descarte);
  banda(iVerde, iVerde + 1, 'CAJ VERDE', COL.verde);

  // ── FILA 2: la presentación de cada par de columnas ───────────────────────
  cols.forEach((c, i) => {
    const col = iProd + i * 2;
    ws.mergeCells(2, col, 2, col + 1);
    const cel = ws.getCell(2, col);
    cel.value = c.nombre;
    cel.alignment = { horizontal: 'center', wrapText: true };
    cel.font = { bold: true, size: 9 };
  });

  // ── FILA 3: los títulos de columna ────────────────────────────────────────
  const titulos = ['Fecha', 'Cant', 'kg'];
  for (const _ of cols) titulos.push('Bultos', 'kg');
  titulos.push('Total bultos', 'Total kg', '%', 'Cant', 'kg', 'Cant', 'kg');
  titulos.forEach((t, i) => {
    const c = ws.getCell(3, i + 1);
    c.value = t;
    c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.cabecera } };
    c.alignment = { horizontal: 'center', wrapText: true };
  });

  // ── LOS DÍAS ──────────────────────────────────────────────────────────────
  let f = 4;
  for (const d of filas) {
    const porNombre = {};
    for (const p of d.presentaciones || []) porNombre[p.nombre] = p;

    const fila = [d.fecha, d.ifcos || 0, n2(d.volcado)];
    for (const c of cols) {
      const p = porNombre[c.nombre];
      fila.push(p ? n2(p.bultos) : 0, p ? n2(p.kilos) : 0);
    }
    fila.push(n2(d.bultos), n2(d.procesado),
      /* El porcentaje es lo COMERCIAL sobre lo volcado del día, que es la columna «%» de
         la planilla a mano. Va como número y no como texto: en texto no se puede
         promediar ni graficar, y eso es la mitad de para qué se baja una planilla. */
      d.volcado > 0 ? n2(d.comercial / d.volcado) : null);
    fila.push(n2(d.descarte_bultos), n2(d.descarte));
    fila.push(n2(d.verde_bultos), n2(d.verde));

    ws.addRow(fila);
    const r = ws.getRow(f);
    r.getCell(iTotal + 2).numFmt = '0%';
    for (let i = 1; i <= ancho; i++) {
      const c = r.getCell(i);
      if (i >= iDesc && i < iVerde) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.descarte } };
      } else if (i >= iVerde) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.verde } };
      } else if (i <= iIngreso + 2) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.ingreso } };
      }
      if (i > 1) c.numFmt = c.numFmt || '#,##0.##';
    }
    f++;
  }

  // ── LA FILA DE TOTALES ────────────────────────────────────────────────────
  // Con fórmulas y no con el número ya hecho: la planilla se va a filtrar y a tocar, y
  // un total congelado deja de coincidir con lo que se ve arriba apenas alguien saque
  // una fila.
  if (filas.length) {
    const r = ws.addRow([]);
    r.getCell(1).value = 'TOTAL';
    for (let i = 2; i <= ancho; i++) {
      if (i === iTotal + 2) continue;   // el % no se suma
      const letra = ws.getColumn(i).letter;
      r.getCell(i).value = { formula: 'SUM(' + letra + '4:' + letra + (f - 1) + ')' };
      r.getCell(i).numFmt = '#,##0.##';
    }
    const colCom = ws.getColumn(iTotal).letter;   // total bultos, no sirve para el %
    r.getCell(iTotal + 2).value = {
      formula: '=IF(' + ws.getColumn(3).letter + f + '=0,"",'
        + ws.getColumn(iTotal + 1).letter + f + '/' + ws.getColumn(3).letter + f + ')',
    };
    r.getCell(iTotal + 2).numFmt = '0%';
    r.font = { bold: true };
    r.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.total } };
    });
    void colCom;
  }

  // ── EL ANCHO DE CADA COLUMNA ──────────────────────────────────────────────
  ws.getColumn(1).width = 12;
  for (let i = 2; i <= ancho; i++) ws.getColumn(i).width = i === iTotal + 2 ? 7 : 10;

  // Y el período, abajo: una planilla sin el período del que habla es una planilla que
  // alguien va a comparar con otra de otro mes sin darse cuenta.
  ws.addRow([]);
  ws.addRow(['Período: ' + desde + ' a ' + hasta]);
  ws.addRow(['Generado el ' + new Date().toLocaleString('es-AR')]);

  return wb.xlsx.writeBuffer();
}
