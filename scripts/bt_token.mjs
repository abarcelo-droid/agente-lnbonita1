// scripts/bt_token.mjs
// Genera, lista y revoca la llave del agente de sincronización de Barceló.
//
//   node scripts/bt_token.mjs                       → lista las llaves
//   node scripts/bt_token.mjs "servidor Transoft"   → genera una nueva
//   node scripts/bt_token.mjs --revocar 3           → revoca la número 3
//
// El token se muestra UNA sola vez. En la base queda el hash: si se pierde, no se
// recupera, se genera otro y listo.
import { generarToken, listarTokens, revocarToken } from '../src/servicios/bt_token.js';

const args = process.argv.slice(2);

function tabla() {
  const filas = listarTokens();
  if (!filas.length) {
    console.log('\nNo hay ninguna llave generada todavía.');
    console.log('Generá una con:  node scripts/bt_token.mjs "servidor Transoft"\n');
    return;
  }
  console.log('\n  #  nombre                estado     último uso           usos');
  console.log('  ' + '─'.repeat(66));
  for (const f of filas) {
    console.log(
      '  ' + String(f.id).padEnd(3) +
      String(f.nombre).slice(0, 20).padEnd(22) +
      (f.revocado_en ? 'REVOCADA ' : 'activa   ').padEnd(11) +
      String(f.ultimo_uso_en || 'nunca usada').padEnd(21) +
      String(f.usos)
    );
  }
  console.log('');
}

if (args[0] === '--revacar' || args[0] === '--revocar') {
  const id = parseInt(args[1], 10);
  if (!id) { console.error('Falta el número de la llave a revocar.'); process.exit(1); }
  console.log(revocarToken(id)
    ? `\nLlave ${id} revocada. El agente que la use va a recibir 401 desde ahora.\n`
    : `\nNo encontré una llave activa con el número ${id}.\n`);
} else if (args.length && !args[0].startsWith('--')) {
  const token = generarToken(args.join(' '), 'consola');
  console.log('\n' + '═'.repeat(72));
  console.log('  LLAVE GENERADA — se muestra UNA sola vez, copiala ahora');
  console.log('═'.repeat(72));
  console.log('\n  ' + token + '\n');
  console.log('═'.repeat(72));
  console.log(`
  Pegala en el servidor de Transoft, en el archivo que va AL LADO de bt_sync.py:

      bt_sync_config.json

      {
        "url":   "https://agente-lnbonita1-production.up.railway.app",
        "token": "${'<'}pegá acá la llave de arriba${'>'}"
      }

  No la mandes por chat ni por mail. Si se filtra:
      node scripts/bt_token.mjs --revocar <número>
`);
} else {
  tabla();
}

process.exit(0);
