// ══ LOS KILOS DEL PAPEL Y LOS KILOS DEL GALPÓN ════════════════════════════
//
// Pablo, 9/9/2026: «Solamente para el caso de los supermercados debemos poder
// remitir MÁS kilos de los ingresados. Por ejemplo si la partida tiene 14 kilos por
// ingresos, debemos poder poner a mano 15 kg para que figure en el remito. Los kilos
// quedan firmes con las recepciones del supermercado y ahí sacamos los kilos para
// facturar».
//
// Y el 10/9, sobre la pregunta de si los kilos de más bajan el stock: «está
// correcto» que NO. Son una DECLARACIÓN EN EL PAPEL, no mercadería que sale.
//
// POR QUÉ PASA. El cajón entra pesado por un factor —14 kg por cajón— y la cadena
// lo pesa en su balanza al recibirlo. Si su balanza dice 15, el remito tiene que
// decir 15 o la recepción no cierra; y lo que se le factura es lo que la cadena
// recibió. Pero de la partida salió UN cajón: descontarle 15 kg a una partida de 14
// la dejaría en negativo por una diferencia de balanza.
//
// ASÍ QUE UN RENGLÓN DE REMITO TIENE DOS NÚMEROS, y cada lector usa el suyo:
//
//   · kg_despachados — los del GALPÓN. Stock, costo, margen, informes. No cambia.
//   · kg_declarados  — los del PAPEL, sólo si se declararon. Lo que se imprime, lo
//                      que se puede facturar y lo que se puede liquidar.
//
// Un solo lugar dice cuál es cuál: si cada pantalla lo resolviera por su cuenta,
// alguna leería el del galpón para facturar y el remito diría 15 con la factura
// trabada en 14 — que es exactamente el problema que esto viene a sacar.

// Hasta cuánto más que lo nominal se acepta declarar. NO ES UNA REGLA DEL NEGOCIO:
// es la red contra el dedo. Ninguna diferencia de balanza llega a la mitad de un
// cajón; un cero de más (150 en vez de 15) o un renglón cargado dos veces, sí. Y lo
// declarado es lo que después se puede FACTURAR: un 150 que pasa es una factura de
// diez veces lo que salió.
export const TOPE_DECLARADO = 1.5;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Los kilos que dice el papel de un renglón: los declarados si los hay, y si no los
// del galpón, que para cualquier remito que no sea a una cadena son lo mismo.
export function kgDelPapel(di) {
  const dec = Number(di && di.kg_declarados);
  if (dec > 0) return dec;
  return Number(di && di.kg_despachados) || 0;
}

// LO MISMO, PARA ADENTRO DE UNA CONSULTA. Hay sumas que se hacen en SQL —«lo
// despachado menos lo facturado, por su precio»— y ésas también tienen que restar
// kilos del papel a kilos del papel. Si restaran lo facturado (15, del papel) a lo
// despachado (14, del galpón), el renglón daría −1 kg y SE COMERÍA la mercadería
// sin facturar de otro renglón en la misma suma.
//
// El NULLIF es por lo mismo que el `> 0` de arriba: un cero no es una declaración.
export function kgPapelSql(alias) {
  const a = String(alias || 'di');
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error('alias inválido: ' + a);
  return `COALESCE(NULLIF(${a}.kg_declarados, 0), ${a}.kg_despachados)`;
}

// Cuántos kilos del papel vale cada kilo del galpón. Lo necesita LO DEVUELTO: la
// devolución se mide en el galpón —es mercadería que vuelve a entrar—, y lo pendiente
// de facturar se mide en el papel. Si la cadena devuelve el renglón entero (14 del
// galpón), tiene que cancelar el renglón entero del papel (15), no dejar 1 kg
// pendiente de facturar que nunca salió.
export function factorDelPapel(di) {
  const nom = Number(di && di.kg_despachados) || 0;
  if (!(nom > 0)) return 1;
  return kgDelPapel(di) / nom;
}

// Lo que queda por facturar de un renglón, en kilos del papel.
export function kgPendienteDelPapel(di, kgDocumentado, kgDevueltoGalpon) {
  return r2(kgDelPapel(di) - (Number(kgDocumentado) || 0)
    - (Number(kgDevueltoGalpon) || 0) * factorDelPapel(di));
}

// Qué se guarda como declarado, o por qué no se acepta.
//
//   · Sólo a una CADENA. A un cliente cualquiera el remito dice lo que salió: no hay
//     una recepción del otro lado que fije los kilos.
//   · Sólo MÁS que lo nominal. Declarar menos no destraba nada —siempre se puede
//     facturar menos de lo pendiente— y abre la puerta a un remito que dice menos de
//     lo que se llevó el camión.
//   · Igual a lo nominal se guarda como nada: no hubo declaración.
export function validarKgDeclarados({ esCadena, kgNominal, kgDeclarados, etiqueta }) {
  const cru = kgDeclarados;
  if (cru == null || cru === '') return { ok: true, kg: null };
  const dec = r2(cru);
  const nom = r2(kgNominal);
  const que = etiqueta ? etiqueta + ': ' : '';
  if (!Number.isFinite(dec) || !(dec > 0)) {
    return { ok: false, error: que + 'los kilos del remito tienen que ser un número mayor a cero.' };
  }
  if (Math.abs(dec - nom) < 0.005) return { ok: true, kg: null };
  if (!esCadena) {
    return { ok: false, error: que + 'sólo a un supermercado se le pueden remitir más kilos que '
      + 'los de la partida. A otro cliente el remito dice lo que salió.' };
  }
  if (dec < nom) {
    return { ok: false, error: que + 'no se declaran menos kilos de los que salen (' + nom + ' kg). '
      + 'Si la cadena recibe menos, se factura menos: no hace falta cambiar el remito.' };
  }
  if (dec > r2(nom * TOPE_DECLARADO)) {
    return { ok: false, error: que + 'declarás ' + dec + ' kg y salen ' + nom + ' kg. Ninguna '
      + 'diferencia de balanza es tan grande: revisá que no sobre un cero.' };
  }
  return { ok: true, kg: dec };
}
