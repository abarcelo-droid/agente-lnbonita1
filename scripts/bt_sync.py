# -*- coding: utf-8 -*-
"""
BARCELO TRANSPORTE - Sincronizador Transoft -> ERP

Corre EN EL SERVIDOR donde estan los .dbf de Transoft. Lee las tablas del modulo
Viajes y Cargas y las EMPUJA al ERP por HTTPS.

POR QUE ASI Y NO AL REVES
El ERP corre en la nube y los .dbf estan en un Windows al que se entra por
escritorio remoto: no hay ruta de uno al otro. Ademas, empujando desde aca el ERP
NUNCA tiene un camino de vuelta hacia Transoft, asi que la regla de oro -el sistema
nuevo lee y jamas escribe- no depende de que nadie se equivoque: depende de que el
camino no exista.

SOLO LECTURA. Este script abre los .dbf en modo 'rb'. No escribe, no bloquea, no
mueve nada. Se puede correr con Transoft abierto y la gente trabajando.

Python puro, sin instalar nada. Mismo lector dBase que ya usa el dashboard.
"""
import os
import sys
import json
import ssl
import struct
import time
import socket
import datetime
import urllib.request
import urllib.error

# ── CONFIGURACION ─────────────────────────────────────────────────────────
# La URL y la llave se leen de un archivo al lado de este script para no tener
# secretos escritos en el codigo ni pasandose por chat.
#
#   bt_sync_config.json  ->  {"url": "https://TU-ERP", "token": "btsync_..."}
#
# La llave se genera UNA vez en el ERP con:
#     node scripts/bt_token.mjs "servidor Transoft"
#
# NO es la cookie de una persona. Antes esto pedia una cookie de sesion y no podia
# funcionar: la cookie de escritorio dura UN DIA, asi que al dia siguiente el agente
# daba 401 y habia que entrar a copiar una nueva a mano. La llave no vence; si se
# filtra, se revoca desde el ERP.
AQUI = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(AQUI, "bt_sync_config.json")
DATOS = r"C:\transoft\Datos"
TANDA = 2000            # filas por request; el ERP acepta hasta 5000
LOG = os.path.join(AQUI, "bt_sync.log")


def log(msg):
    linea = "[%s] %s" % (datetime.datetime.now().strftime("%d/%m %H:%M:%S"), msg)
    print(linea)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(linea + "\n")
    except Exception:
        pass


# ── LECTOR DE .DBF (dBase / Visual FoxPro) ────────────────────────────────
# Formato: cabecera de 32 bytes, despues los descriptores de campo hasta 0x0D,
# despues los registros. Un registro que arranca con 0x2A esta borrado.

def leer_dbf(ruta, columnas=None):
    """Devuelve una lista de diccionarios. `columnas` limita que campos traer.

    Se leen SOLO las columnas pedidas: Transoft tiene decenas de campos de
    auditoria por fila y mandarlos todos multiplicaria por diez el trafico sin
    aportar nada.
    """
    with open(ruta, "rb") as f:
        cab = f.read(32)
        if len(cab) < 32:
            return []
        cant = struct.unpack("<I", cab[4:8])[0]
        inicio = struct.unpack("<H", cab[8:10])[0]
        largo_reg = struct.unpack("<H", cab[10:12])[0]

        campos = []
        pos = 1                      # byte 0 del registro = marca de borrado
        while True:
            d = f.read(32)
            if not d or d[0:1] in (b"\x0d", b""):
                break
            nombre = d[0:11].split(b"\x00")[0].decode("latin-1").strip().upper()
            tipo = d[11:12].decode("latin-1")
            largo = d[16]
            dec = d[17]
            campos.append((nombre, tipo, largo, dec, pos))
            pos += largo

        quiero = None
        if columnas:
            quiero = set(c.upper() for c in columnas)
            # Una columna que se pide y no esta se ignoraba en silencio: la fila
            # salia sin ese dato y nadie se enteraba. Asi estuvo pidiendose ANULADO
            # en clientes/choferes/unidades, que no lo tienen, y CODSUC+CUENTA en
            # choferes, que directamente son la clave equivocada. Ahora avisa.
            faltan = sorted(quiero - set(n for (n, _t, _l, _d, _p) in campos))
            if faltan:
                print("  [OJO] %s no tiene estas columnas: %s"
                      % (os.path.basename(ruta), ", ".join(faltan)))

        f.seek(inicio)
        filas = []
        for _ in range(cant):
            reg = f.read(largo_reg)
            if len(reg) < largo_reg:
                break
            if reg[0:1] == b"\x2a":          # borrado
                continue
            fila = {}
            for (nombre, tipo, largo, dec, p) in campos:
                if quiero is not None and nombre not in quiero:
                    continue
                crudo = reg[p:p + largo]
                fila[nombre.lower()] = _valor(crudo, tipo, dec)
            filas.append(fila)
        return filas


def _valor(crudo, tipo, dec):
    """Convierte un campo dBase al tipo que espera el ERP."""
    if tipo == "C":
        return crudo.decode("latin-1").rstrip().strip() or None
    if tipo in ("N", "F", "B"):
        t = crudo.decode("latin-1").strip()
        if not t:
            return None
        try:
            return float(t)
        except ValueError:
            return None
    if tipo == "D":
        t = crudo.decode("latin-1").strip()
        # AAAAMMDD -> AAAA-MM-DD, que es como guarda fechas todo el ERP.
        if len(t) == 8 and t.isdigit() and t != "00000000":
            return t[0:4] + "-" + t[4:6] + "-" + t[6:8]
        return None
    if tipo == "T":
        t = crudo.decode("latin-1").strip()
        if len(t) >= 8 and t[:8].isdigit():
            return t[0:4] + "-" + t[4:6] + "-" + t[6:8]
        return None
    if tipo == "L":
        return crudo.decode("latin-1").strip().upper() in ("T", "Y", "S", "1")
    if tipo == "I":
        return struct.unpack("<i", crudo[:4])[0] if len(crudo) >= 4 else None
    if tipo == "Y":
        # Moneda de FoxPro: entero de 64 bits con 4 decimales implicitos.
        return struct.unpack("<q", crudo[:8])[0] / 10000.0 if len(crudo) >= 8 else None
    return crudo.decode("latin-1").rstrip() or None


# ── QUE SE SINCRONIZA ─────────────────────────────────────────────────────
# (clave en el ERP, archivo .dbf, columnas a traer)
# Los nombres de columna son los de Transoft; el ERP los espeja tal cual.
def armar_plan(datos):
    """Arma la lista de que sincronizar a partir de la carpeta de datos."""
    CGRALES = os.path.join(datos, "CGRALES")
    GENERAL = os.path.join(datos, "GENERAL")
    UNIDADES = os.path.join(datos, "UNIDADES")
    return [
    ("catalogos",  None, None),          # se arma aparte, mas abajo
    ("localidades", os.path.join(GENERAL, "localida.dbf"),
     ["LOCALIDAD", "DESCRIP", "PROVIN", "CENTRO", "ZONA", "SUCURSAL"]),
    ("provincias", os.path.join(GENERAL, "provin.dbf"),
     ["PROVINCIA", "DESCRIP", "PAIS"]),
    # OJO con la baja de los maestros: clientes, choferes y unidades NO tienen
    # ANULADO. Tienen BAJA, y es una FECHA (con fecha = dado de baja).
    ("clientes",   os.path.join(GENERAL, "clientes.dbf"),
     ["CODSUC", "FICHANRO", "RESUM", "RAZSOCC", "CUIT", "IVA", "ZONA", "CTACTE", "CONDVTA", "BAJA"]),
    # El chofer se identifica por CHRESUM, no por sucursal+numero como el resto.
    ("choferes",   os.path.join(GENERAL, "choferes.dbf"),
     ["CHRESUM", "NOMBRE", "LEGAJO", "CUIT", "DOCUMEN", "REGISTRO", "TELEFONO",
      "CHOFERPROP", "PVCODSUC", "PVCUENTA", "BAJA"]),
    ("unidades",   os.path.join(UNIDADES, "unpadron.dbf"),
     ["TIPUNI", "UNIDAD", "PATENTE", "DESCRIP", "MARCA", "ANIO", "KM", "CHOFER", "BAJA"]),
    # Dos filas, y de las mas importantes: ULTCARGA y ULTVIAJE son los contadores
    # desde donde el ERP tiene que seguir numerando para no pisar la historia.
    ("filiales",   os.path.join(CGRALES, "cgfilial.dbf"),
     ["FILIAL", "DESCRIP", "SUCURSAL", "ULTCARGA", "ULTVIAJE", "ESTVIAINI"]),
    ("viajes",     os.path.join(CGRALES, "cgviaje1.dbf"),
     ["FILIAL", "NROVIA", "FECVIAJE", "TIPOVIAJE", "CAMION", "SEMI", "SEMI2", "CHRESUM",
      "CHOFERPROP", "ORIGEN", "DESTINO", "TRAYECTO", "KMSTD", "KMREAL", "KMINI", "KMFIN",
      "TRGASOIL", "MEDIA", "RINDE", "TOTM3", "TOTKG", "TOTBULTOS", "ESTADO", "CIERRE", "ANULADO"]),
    ("cargas",     os.path.join(CGRALES, "cgcarga1.dbf"),
     ["FILIAL", "NROCAR", "FECHAING", "CLISUC", "CLINRO", "AFCSUC", "AFCNRO", "REMSUC", "REMNRO",
      "DESSUC", "DESNRO", "TIPOCARGA", "SERVICIO", "M3", "KG", "BULTOS", "TIPOBULTO",
      "ORIGEN", "DESTINO", "TRAYECTO", "IMPFLETE", "VALORDEC", "FOJASUC", "FOJANRO",
      # OJO: cgcarga1 NO tiene ESTADO. El estado fisico de la carga (TT/ED/NE/...)
      # vive en el cruce carga-viaje, en cgcarvia.ESTADO. Lo que cgcarga1 si tiene
      # es CERRADA, que es el flag de "esta terminada".
      "CONFORME", "CERRADA", "COMENT", "ANULADO"]),
    ("carga_viaje", os.path.join(CGRALES, "cgcarvia.dbf"),
     ["CARGASUC", "CARGANRO", "RENGLON", "VIAJESUC", "VIAJENRO", "RENGVIA", "TRAMOSUC", "TRAMONRO",
      "CANTIDAD", "M3EMBAR", "KGEMBAR", "BULEMBAR", "SALDOM3", "SALDOKG", "SALDOBUL",
      # cgcarvia tampoco tiene ANULADO (lo confirma el aviso [OJO] de la corrida).
      "ESTADO", "CONFORME", "ULTIMO"]),
    ("valor_carga", os.path.join(CGRALES, "cgvalcar.dbf"),
     ["CARGASUC", "CARGANRO", "RENGLON", "CONCEPTO", "DESCRIP", "CLIFCSUC", "CLIFCNRO",
      "PRECIO", "IMPORTE", "CONIVA", "PERCIB", "FACSUC", "FACNRO", "ANULADO"]),
    ("valor_viaje", os.path.join(CGRALES, "cgvalvia.dbf"),
     ["VIAJESUC", "VIAJENRO", "RENGLON", "CONCEPTO", "TARIFARIO", "PRECIO", "IMPORTE",
      "LIQUIDAR", "EXENTO", "ORDENSUC", "ORDENNRO", "ANULADO"]),
    ("documentos", os.path.join(CGRALES, "cgdocum.dbf"),
     ["CARGASUC", "CARGANRO", "RENGLON", "TIPODOC", "LETRA", "CENTRO", "NUMERO", "FECHA",
      "DESCRIP", "ANULADO"]),
    ("ordenes",    os.path.join(CGRALES, "cgorden.dbf"),
     ["TIPORDEN", "NROORDEN", "TIPUNI", "UNIDAD", "CHRESUM", "VIAJESUC", "VIAJENRO",
      "ESSUC", "ESFICHA", "IMPORTE", "LITROS", "KM", "REMLETRA", "REMCE", "REMNRO",
      "FECHA", "ANULADO"]),
    ("fojas",      os.path.join(datos, "ENCOMIEN", "avfoja.dbf"),
     ["FOJASUC", "FOJANRO", "FOJACAMION", "FOJAPLACA", "FOJASEMI", "PLACASEMI",
      "FOJACHOF", "FOJADEST", "FOJAGUIA", "ANULADO"]),
    ]

# Los catalogos son ocho tablitas de referencia. Van todas a bt_tr_catalogos con
# una columna que dice de cual son.
CATALOGOS = [
    ("tipo_carga",    "cgtipcar.dbf"),
    ("tipo_bulto",    "cgtipbul.dbf"),
    ("tipo_doc",      "cgtipdoc.dbf"),
    ("estado_carga",  "cgestado.dbf"),
    ("estado_viaje",  "cgestvia.dbf"),
    ("conformidad",   "cgconfor.dbf"),
    ("zona",          "cgzona.dbf"),
    ("concepto_carga", "cgconcar.dbf"),
    ("concepto_viaje", "cgconvia.dbf"),
]


def leer_catalogos(CGRALES):
    """Junta las tablitas de referencia en una sola lista."""
    filas = []
    for (nombre, archivo) in CATALOGOS:
        ruta = os.path.join(CGRALES, archivo)
        if not os.path.isfile(ruta):
            log("  catalogo %s: no esta %s" % (nombre, archivo))
            continue
        try:
            crudo = leer_dbf(ruta)
        except Exception as e:
            log("  catalogo %s: no se pudo leer (%s)" % (nombre, e))
            continue
        for i, f in enumerate(crudo):
            # El codigo y la descripcion cambian de nombre segun la tablita: se
            # toma la primera columna corta como codigo y la primera larga como
            # descripcion, que es como estan armadas todas.
            codigo = None
            descrip = None
            for k, v in f.items():
                if v is None:
                    continue
                sv = str(v).strip()
                if not sv:
                    continue
                if codigo is None and len(sv) <= 4:
                    codigo = sv
                elif descrip is None and len(sv) > 2:
                    descrip = sv
            if codigo:
                filas.append({"catalogo": nombre, "codigo": codigo,
                              "descrip": descrip, "orden": i})
    return filas


# ── ENVIO AL ERP ──────────────────────────────────────────────────────────

def cargar_config():
    if not os.path.isfile(CONFIG):
        log("FALTA EL ARCHIVO DE CONFIGURACION: %s" % CONFIG)
        log('Tiene que tener: {"url": "https://TU-ERP", "token": "btsync_..."}')
        log('La llave se genera en el ERP con: node scripts/bt_token.mjs "servidor Transoft"')
        sys.exit(1)
    with open(CONFIG, "r", encoding="utf-8") as f:
        c = json.load(f)
    if not c.get("url"):
        log("La configuracion tiene que tener 'url'.")
        sys.exit(1)
    if not c.get("token") and not c.get("cookie"):
        log("La configuracion tiene que tener 'token' (la llave del agente).")
        log('Se genera en el ERP con: node scripts/bt_token.mjs "servidor Transoft"')
        sys.exit(1)
    return c


def postear(cfg, camino, cuerpo):
    datos = json.dumps(cuerpo).encode("utf-8")
    cabeceras = {"Content-Type": "application/json"}
    if cfg.get("token"):
        cabeceras["X-BT-Token"] = cfg["token"]
    if cfg.get("cookie"):          # compatibilidad con una config vieja
        cabeceras["Cookie"] = cfg["cookie"]
    req = urllib.request.Request(
        cfg["url"].rstrip("/") + camino, data=datos, method="POST",
        headers=cabeceras)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=180, context=ctx) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    cfg = cargar_config()
    datos = cfg.get("datos") or DATOS_DEFECTO
    if not os.path.isdir(datos):
        log("NO ENCUENTRO LA CARPETA DE TRANSOFT: %s" % datos)
        log('Si esta en otro lado, agregalo al config:  "datos": "D:\\\\ruta\\\\Datos"')
        return 1
    plan = armar_plan(datos)
    origen = socket.gethostname()
    log("=" * 70)
    log("Sincronizando Transoft -> ERP  (origen: %s)" % origen)
    log("Leyendo de: %s   (SOLO LECTURA)" % datos)

    lote = None
    resumen = {}
    hubo_error = None
    t0 = time.time()

    for (clave, ruta, columnas) in plan:
        try:
            if clave == "catalogos":
                filas = leer_catalogos(os.path.join(datos, "CGRALES"))
            else:
                if not os.path.isfile(ruta):
                    log("  %-13s NO ESTA: %s" % (clave, ruta))
                    continue
                filas = leer_dbf(ruta, columnas)
        except Exception as e:
            log("  %-13s ERROR leyendo: %s" % (clave, e))
            hubo_error = "%s: %s" % (clave, e)
            continue

        enviadas = 0
        for i in range(0, len(filas), TANDA):
            tanda = filas[i:i + TANDA]
            try:
                r = postear(cfg, "/api/bt/sync",
                            {"tabla": clave, "filas": tanda, "lote_id": lote, "origen": origen})
            except urllib.error.HTTPError as e:
                detalle = e.read().decode("utf-8", "replace")[:300]
                log("  %-13s ERROR HTTP %s: %s" % (clave, e.code, detalle))
                hubo_error = "%s: HTTP %s" % (clave, e.code)
                break
            except Exception as e:
                log("  %-13s ERROR de red: %s" % (clave, e))
                hubo_error = "%s: %s" % (clave, e)
                break
            if not r.get("ok"):
                log("  %-13s RECHAZADO: %s" % (clave, r.get("error")))
                hubo_error = "%s: %s" % (clave, r.get("error"))
                break
            lote = r.get("lote_id") or lote
            enviadas += r.get("escritas", 0)
            if r.get("errores"):
                log("  %-13s %d fila(s) con problema, ej: %s"
                    % (clave, len(r["errores"]), r["errores"][0].get("error", "")[:120]))
            # Columnas que Transoft no trajo y el ERP completo con su default. Se
            # muestra para que no pase inadvertido que una tabla llego sin un dato.
            rel = r.get("rellenos") or {}
            if rel:
                detalle = ", ".join("%s(%d)" % (k, v) for k, v in sorted(rel.items()))
                log("  %-13s completadas por defecto: %s" % (clave, detalle))

        resumen[clave] = enviadas
        log("  %-13s %6d filas" % (clave, enviadas))

    if lote:
        try:
            postear(cfg, "/api/bt/sync/cerrar",
                    {"lote_id": lote, "tablas": resumen, "error": hubo_error})
        except Exception as e:
            log("No se pudo cerrar el lote: %s" % e)

    total = sum(resumen.values())
    log("-" * 70)
    log("LISTO. %d filas en %.1f segundos%s"
        % (total, time.time() - t0, "  (CON ERRORES)" if hubo_error else ""))
    return 1 if hubo_error else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("Cancelado por el usuario.")
        sys.exit(1)
