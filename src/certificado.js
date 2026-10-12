/*
 * Certificado Digital de Intención Comercial — composición del PDF.
 *
 * Adaptado de hcga-registro (backend/src/services/certificado.service.js y
 * backend/src/config/certificado.layout.js). No importa nada: recibe pdf-lib y
 * qrcode-generator como parámetros, así se puede probar de forma aislada.
 *
 * Los valores salen de una fila de public.certificates, que ya guarda los
 * datos enmascarados, la URL de verificación y el sello tal como se imprimen.
 */

const ZONA_HORARIA = "America/New_York";
const AVANCE_MONO = 0.602; // avance de DejaVu Sans Mono, la fuente de la plantilla

const COLOR = {
  TEXTO: [0x1b / 255, 0x20 / 255, 0x24 / 255],
  FONDO_CABECERA: [0xf6 / 255, 0xf4 / 255, 0xef / 255],
  FONDO_BLANCO: [1, 1, 1],
};

// Línea base de cada marcador en puntos PDF (origen abajo-izquierda, Carta 612 x 792).
const M = (clave, etiqueta, x, y, maxAncho, fuente, fondo) => ({ clave, etiqueta, x, y, maxAncho, fuente, fondo });
const MARCADORES = [
  M("CI_CODIGO_UNICO", "{{CI_CODIGO_UNICO}}", 467.99, 741.75, 130, 8.0, COLOR.FONDO_BLANCO),
  M("CI_CODIGO_UNICO", "{{CI_CODIGO_UNICO}}", 63.33, 625.5, 380, 7.6, COLOR.FONDO_CABECERA),
  M("FECHA_HORA_EMISION", "{{FECHA_HORA_EMISION}}", 63.33, 603.75, 380, 7.6, COLOR.FONDO_CABECERA),
  M("ESTADO_ACTUAL", "{{ESTADO_ACTUAL}}", 190.92, 578.25, 320, 7.6, COLOR.FONDO_CABECERA),
  M("EMPRESA_IDENTIFICACION", "{{EMPRESA_IDENTIFICACION}}", 313.99, 529.5, 240, 7.6, COLOR.FONDO_BLANCO),
  M("CLIENTE_NOMBRE", "{{CLIENTE_NOMBRE}}", 52.58, 460.5, 250, 7.6, COLOR.FONDO_BLANCO),
  M("CLIENTE_ID_PARCIAL", "{{CLIENTE_ID_PARCIAL}}", 52.58, 435.75, 250, 7.6, COLOR.FONDO_BLANCO),
  M("CLIENTE_ROL", "{{CLIENTE_ROL: Shipper | Carrier}}", 313.99, 435.75, 235, 7.6, COLOR.FONDO_BLANCO),
  M("CLIENTE_EMAIL_ENMASCARADO", "{{CLIENTE_EMAIL_ENMASCARADO}}", 52.58, 411.0, 250, 7.6, COLOR.FONDO_BLANCO),
  M("CLIENTE_TELEFONO_ENMASCARADO", "{{CLIENTE_TELEFONO_ENMASCARADO}}", 313.99, 411.0, 235, 7.6, COLOR.FONDO_BLANCO),
  M("CI_CODIGO_UNICO", "{{CI_CODIGO_UNICO}}", 52.58, 134.25, 250, 7.6, COLOR.FONDO_BLANCO),
  M("URL_VERIFICACION", "{{URL_VERIFICACION}}", 313.99, 134.25, 235, 7.6, COLOR.FONDO_BLANCO),
  M("ESTADO_CERTIFICADO", "{{ESTADO_CERTIFICADO}}", 52.58, 109.5, 250, 7.6, COLOR.FONDO_BLANCO),
  M("FECHA_VERIFICACION", "{{FECHA_VERIFICACION}}", 313.99, 109.5, 235, 7.6, COLOR.FONDO_BLANCO),
  M("SELLO_DIGITAL", "{{SELLO_DIGITAL}}", 136.98, 50.25, 210, 7.0, COLOR.FONDO_BLANCO),
  M("FECHA_HORA_ACEPTACION", "{{FECHA_HORA_ACEPTACION}}", 386.55, 61.5, 175, 7.0, COLOR.FONDO_BLANCO),
  M("CI_CODIGO_UNICO", "{{CI_CODIGO_UNICO}}", 472.55, 28.5, 130, 7.6, COLOR.FONDO_BLANCO),
];
// Hueco del QR: recuadro discontinuo de la plantilla.
const QR = { x: 473.1, y: 589.5, tamano: 50.6, margenInterior: 1.5, nivelCorreccion: "M", margenBlanco: 1 };
const ROLES = { carrier: "Carrier", shipper: "Shipper" };

export function fechaCertificado(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-US", {
    timeZone: ZONA_HORARIA, dateStyle: "medium", timeStyle: "short", hour12: false,
  }).format(d) + " ET";
}

function limpiar(texto, maximo = 160) {
  if (texto === null || texto === undefined) return "—";
  const t = String(texto).replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > maximo ? `${t.slice(0, maximo - 1)}…` : t;
}

export function valoresDe(c) {
  const verificado = c.status === "verified";
  return {
    CI_CODIGO_UNICO: c.cui,
    FECHA_HORA_EMISION: fechaCertificado(c.issued_at),
    ESTADO_ACTUAL: verificado ? "Verificado" : "Registrado",
    EMPRESA_IDENTIFICACION: c.company_identification || "—",
    CLIENTE_NOMBRE: limpiar(c.holder_name, 90),
    CLIENTE_ID_PARCIAL: c.holder_id_masked || "—",
    CLIENTE_ROL: ROLES[c.holder_role] || c.holder_role,
    CLIENTE_EMAIL_ENMASCARADO: c.holder_email_masked || "—",
    CLIENTE_TELEFONO_ENMASCARADO: c.holder_phone_masked || "—",
    URL_VERIFICACION: c.verification_url,
    ESTADO_CERTIFICADO: verificado ? "Verificado" : "Pendiente de confirmación",
    FECHA_VERIFICACION: verificado ? fechaCertificado(c.verified_at) : "—",
    SELLO_DIGITAL: c.seal,
    // Instante en que HCGA emitió el documento al titular (ver hoja interna).
    FECHA_HORA_ACEPTACION: fechaCertificado(c.issued_at),
  };
}

const anchoDe = (fuente, texto, tamano) => fuente.widthOfTextAtSize(texto, tamano);

// Courier (fuente estándar) solo cubre WinAnsi: el resto de caracteres se
// sustituye para que pdf-lib no falle con nombres poco habituales.
function apto(fuente, texto) {
  const soportados = new Set(fuente.getCharacterSet());
  return Array.from(texto).map((ch) => (soportados.has(ch.codePointAt(0)) ? ch : "?")).join("");
}

// La plantilla usa una fuente de avance 0.602 em; Courier tiene 0.6 em.
function ajustarTamanoFuente(fuente, tamano) {
  const avance = anchoDe(fuente, "MMMMMMMMMM", tamano) / 10 / tamano;
  if (!avance || Math.abs(avance - AVANCE_MONO) < 0.001) return tamano;
  return Math.round(tamano * (AVANCE_MONO / avance) * 100) / 100;
}

// 1) reducir el cuerpo hasta el 70 %; 2) si aún no cabe, recortar con "…".
function ajustarAlAncho(texto, fuente, tamano, maxAncho) {
  if (!maxAncho || anchoDe(fuente, texto, tamano) <= maxAncho) return { texto, tamano };
  const minimo = tamano * 0.7;
  let cuerpo = tamano;
  while (cuerpo > minimo && anchoDe(fuente, texto, cuerpo) > maxAncho) cuerpo = Math.round((cuerpo - 0.1) * 100) / 100;
  if (anchoDe(fuente, texto, cuerpo) <= maxAncho) return { texto, tamano: cuerpo };
  let recortado = texto;
  while (recortado.length > 1 && anchoDe(fuente, `${recortado}…`, cuerpo) > maxAncho) recortado = recortado.slice(0, -1);
  return { texto: `${recortado}…`, tamano: cuerpo };
}

function pintarMarcador(PDFLib, pagina, m, valor, fuente) {
  const ajuste = ajustarAlAncho(apto(fuente, limpiar(valor)), fuente, m.fuente, m.maxAncho);
  pagina.drawRectangle({
    x: m.x - 1, y: m.y - m.fuente * 0.3,
    width: anchoDe(fuente, m.etiqueta, m.fuente) + 2, height: m.fuente * 1.4,
    color: PDFLib.rgb(...m.fondo),
  });
  pagina.drawText(ajuste.texto, { x: m.x, y: m.y, size: ajuste.tamano, font: fuente, color: PDFLib.rgb(...COLOR.TEXTO) });
}

// QR vectorial (nítido a cualquier zoom), en el hueco reservado de la plantilla.
function insertarQr(PDFLib, qrcode, pagina, texto) {
  const qr = qrcode(0, QR.nivelCorreccion);
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const lado = QR.tamano - QR.margenInterior * 2;
  const modulo = lado / (n + QR.margenBlanco * 2);
  const x0 = QR.x + QR.margenInterior + QR.margenBlanco * modulo;
  const yTop = QR.y + QR.margenInterior + lado - QR.margenBlanco * modulo;
  const negro = PDFLib.rgb(0, 0, 0);

  pagina.drawRectangle({ x: QR.x, y: QR.y, width: QR.tamano, height: QR.tamano, color: PDFLib.rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const inicio = c;
      while (c + 1 < n && qr.isDark(r, c + 1)) c++;
      pagina.drawRectangle({
        x: x0 + inicio * modulo, y: yTop - (r + 1) * modulo,
        width: (c - inicio + 1) * modulo, height: modulo, color: negro,
      });
    }
  }
}

/**
 * @param {{ PDFLib: object, qrcode: Function, plantilla: Uint8Array, certificado: object }} p
 *   certificado = fila de public.certificates
 * @returns {Promise<Uint8Array>}
 */
export async function generarCertificado({ PDFLib, qrcode, plantilla, certificado: c }) {
  for (const k of ["cui", "issued_at", "verification_url", "seal", "holder_name", "holder_role"]) {
    if (!c || !c[k]) throw new Error(`Falta el dato del certificado: ${k}`);
  }
  const doc = await PDFLib.PDFDocument.load(plantilla);
  const pagina = doc.getPage(0);
  const fuente = await doc.embedFont(PDFLib.StandardFonts.Courier);
  const valores = valoresDe(c);

  for (const m of MARCADORES) {
    const valor = valores[m.clave];
    if (valor === undefined) continue;
    pintarMarcador(PDFLib, pagina, { ...m, fuente: ajustarTamanoFuente(fuente, m.fuente) }, valor, fuente);
  }
  insertarQr(PDFLib, qrcode, pagina, c.verification_url);

  doc.setTitle(`Certificado ${c.cui}`);
  doc.setSubject("Certificado Digital de Intencion Comercial - HCGA Trading LLC");
  doc.setCreator("HCGA Trading LLC");
  doc.setProducer("HCGA Trading LLC");
  doc.setCreationDate(new Date(c.issued_at));
  doc.setModificationDate(new Date(c.issued_at));
  return doc.save({ useObjectStreams: false });
}
