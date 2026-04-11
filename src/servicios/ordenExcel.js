import ExcelJS from "exceljs";

export async function generarOrdenExcel(pedido) {
  const wb    = new ExcelJS.Workbook();
  const ws    = wb.addWorksheet("Orden de Trabajo");
  const hoy   = new Date().toLocaleDateString("es-AR");
  const esCCte = ["mayorista","mayorista_b","food_service"].includes(pedido.tipo_cliente);

  let detalle = [];
  try { detalle = JSON.parse(pedido.detalle); } catch {}

  // Título
  ws.mergeCells("A1:G1");
  const t = ws.getCell("A1");
  t.value = `La Niña Bonita — Orden de Trabajo #${pedido.id}`;
  t.font  = { bold: true, size: 14 };
  t.fill  = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF1E3A2F" } };
  t.font  = { bold:true, size:14, color:{ argb:"FFFFFFFF" } };
  t.alignment = { horizontal:"center" };
  ws.getRow(1).height = 28;

  // Info
  ws.addRow([]);
  ws.addRow(["Fecha:", hoy, "", "Cliente:", pedido.telefono]);
  ws.addRow(["Tipo:", labelTipo(pedido.tipo_cliente), "", "Pago:", esCCte ? "Cuenta Corriente" : "Mercado Pago"]);
  if (pedido.horario_entrega) ws.addRow(["Horario entrega:", pedido.horario_entrega]);
  ws.addRow(["Estado:", (pedido.estado || "pendiente").toUpperCase()]);
  ws.addRow([]);

  // Encabezado tabla
  const header = ws.addRow(["Código","Producto","Descripción","Cantidad","Precio unit.","Subtotal","Stock"]);
  header.eachCell(cell => {
    cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF2D2D2D" } };
    cell.font = { bold:true, color:{ argb:"FFFFFFFF" } };
    cell.alignment = { horizontal:"center" };
  });

  // Productos
  let total = 0;
  detalle.forEach((item, i) => {
    const sub  = (item.cantidad||1) * (item.precio_unit||0);
    total += sub;
    const row  = ws.addRow([
      item.codigo||"-", item.nombre||"-", item.descripcion||"",
      item.cantidad||1,
      { formula:`E${ws.rowCount}`, result: item.precio_unit||0 },
      sub,
      item.stock !== false ? "✓" : "Sin stock"
    ]);
    if (i % 2 === 0) {
      row.eachCell(cell => cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFF5F5F5" } });
    }
    row.getCell(5).numFmt = '"$"#,##0';
    row.getCell(6).numFmt = '"$"#,##0';
  });

  // Total
  ws.addRow([]);
  const totalRow = ws.addRow(["","","","","TOTAL", total, ""]);
  totalRow.getCell(5).font  = { bold:true, size:12 };
  totalRow.getCell(6).font  = { bold:true, size:12 };
  totalRow.getCell(6).numFmt = '"$"#,##0';

  // Anchos
  ws.columns = [
    {width:12},{width:28},{width:24},{width:10},{width:14},{width:14},{width:10}
  ];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function labelTipo(t) {
  return { mayorista:"Mayorista A", mayorista_b:"Mayorista B", minorista:"Minorista", food_service:"Food Service" }[t] || t;
}
