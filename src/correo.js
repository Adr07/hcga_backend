/*
 * Correo automático al titular: confirmación del registro + certificado PDF adjunto.
 *
 * Texto basado en la hoja interna de la plantilla (sección D, "Correo que
 * acompaña al certificado"). Se escribe "recibimos y registramos su interés",
 * nunca "fue aceptado": "aceptado" puede leerse como que HCGA ya aceptó a la
 * persona como cliente.
 *
 * redactarCorreo() solo compone el mensaje; un transporte lo envía:
 *   crearTransportePasarela()  HTTPS a correo/enviar.php del cPanel (servidor de
 *                              correo de GoDaddy). Es el que funciona en GoDaddy
 *                              Node.js Hosting, que bloquea el SMTP saliente.
 *   crearTransporteSmtp()      SMTP directo (útil en local o en otro hosting).
 */
import nodemailer from "nodemailer";
import { createHmac } from "node:crypto";

const CONTACTO = "ing.alberto@hcgatrading.com";

const TEXTOS = {
  es: {
    asunto: "Recibimos su registro de interés — HCGA Trading LLC",
    hola: (n) => `Hola ${n},`,
    recibimos: "recibimos y registramos su interés en la plataforma de HCGA Trading LLC.",
    adjunto: (cui) => `Adjuntamos su Certificado Digital de Intención Comercial (código ${cui}).`,
    confirmar: "Para confirmar su correo electrónico, haga clic aquí:",
    boton: "Confirmar mi correo",
    caduca: "El enlace es válido durante 7 días.",
    yaConfirmado: "Su correo electrónico ya está confirmado.",
    verificar: "Cualquiera puede comprobar la autenticidad del certificado con su código QR o en:",
    noContrato: "Este certificado no es un contrato y registrarse no tiene ningún costo.",
    contacto: "Nos pondremos en contacto con usted sobre el lanzamiento de la plataforma.",
    corregir: `Para corregir o eliminar su registro: ${CONTACTO}.`,
    pie: "Este mensaje se envió automáticamente porque usted se registró en hcgatrading.com.",
  },
  en: {
    asunto: "We received your registration of interest — HCGA Trading LLC",
    hola: (n) => `Hello ${n},`,
    recibimos: "we received and registered your interest in the HCGA Trading LLC platform.",
    adjunto: (cui) => `Attached is your Digital Certificate of Commercial Intent (code ${cui}).`,
    confirmar: "To confirm your email address, click here:",
    boton: "Confirm my email",
    caduca: "The link is valid for 7 days.",
    yaConfirmado: "Your email address is already confirmed.",
    verificar: "Anyone can check the certificate's authenticity with its QR code or at:",
    noContrato: "This certificate is not a contract and registering has no cost.",
    contacto: "We will contact you about the platform launch.",
    corregir: `To correct or delete your registration: ${CONTACTO}.`,
    pie: "This message was sent automatically because you registered at hcgatrading.com.",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * @param {object} p
 * @param {object} p.certificado  fila de public.certificates
 * @param {object} p.titular      { email, name, language, verification_token, verification_expires_at, status }
 * @param {Uint8Array} p.pdf
 */
export function redactarCorreo({ certificado: c, titular: t, pdf }) {
  const L = TEXTOS[t.language === "en" ? "en" : "es"];
  const origen = new URL(c.verification_url).origin;
  const vigente = t.verification_token && t.status === "registered" &&
    (!t.verification_expires_at || new Date(t.verification_expires_at) > new Date());
  const enlace = vigente ? `${origen}/confirmar.html?t=${encodeURIComponent(t.verification_token)}` : null;

  const texto = [
    L.hola(t.name),
    "",
    `${L.recibimos} ${L.adjunto(c.cui)}`,
    "",
    enlace ? `${L.confirmar} ${enlace}\n${L.caduca}` : L.yaConfirmado,
    "",
    `${L.verificar} ${c.verification_url}`,
    "",
    `${L.noContrato} ${L.contacto} ${L.corregir}`,
    "",
    "HCGA Trading LLC · www.hcgatrading.com",
    L.pie,
  ].join("\n");

  const boton = enlace
    ? `<p style="margin:24px 0 8px">${esc(L.confirmar)}</p>
       <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:100px;background:#9E2A2F">
         <a href="${esc(enlace)}" style="display:inline-block;padding:13px 28px;font:700 16px Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:100px">${esc(L.boton)}</a>
       </td></tr></table>
       <p style="margin:10px 0 0;font-size:13px;color:#6A7077">${esc(L.caduca)}<br><a href="${esc(enlace)}" style="color:#9E2A2F;word-break:break-all">${esc(enlace)}</a></p>`
    : `<p style="margin:24px 0 0">${esc(L.yaConfirmado)}</p>`;

  const html = `<!doctype html><html lang="${t.language === "en" ? "en" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F6F4EF">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F4EF"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #D9D2C7;border-radius:12px">
  <tr><td style="padding:22px 28px;border-bottom:3px solid #9E2A2F;font:700 22px Arial,sans-serif;color:#1B2024">HCGA <span style="font:600 11px Arial,sans-serif;letter-spacing:2px;color:#6A7077">TRADING LLC</span></td></tr>
  <tr><td style="padding:26px 28px;font:15px/1.55 Arial,sans-serif;color:#1B2024">
    <p style="margin:0 0 14px">${esc(L.hola(t.name))}</p>
    <p style="margin:0">${esc(L.recibimos)} ${esc(L.adjunto(c.cui))}</p>
    ${boton}
    <p style="margin:24px 0 0;font-size:14px;color:#3A4046">${esc(L.verificar)}<br><a href="${esc(c.verification_url)}" style="color:#9E2A2F;word-break:break-all">${esc(c.verification_url)}</a></p>
    <p style="margin:24px 0 0;font-size:14px;color:#3A4046">${esc(L.noContrato)} ${esc(L.contacto)} ${esc(L.corregir)}</p>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #E6E1D8;font:12px/1.5 Arial,sans-serif;color:#6A7077">HCGA Trading LLC · <a href="https://www.hcgatrading.com" style="color:#6A7077">www.hcgatrading.com</a><br>${esc(L.pie)}</td></tr>
</table></td></tr></table></body></html>`;

  return {
    to: t.email,
    subject: L.asunto,
    text: texto,
    html,
    attachments: [{ filename: `CERT-${c.cui}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
    confirmLink: enlace,
  };
}

/**
 * Transporte SMTP (Microsoft 365: smtp.office365.com:587 con STARTTLS).
 * Requiere que la "Autenticación SMTP" del buzón esté activada en GoDaddy.
 */
export function crearTransporteSmtp({ host, port, user, pass, from, fromName }) {
  const transporte = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
  return {
    async send({ to, subject, text, html, attachments }) {
      const info = await transporte.sendMail({ from: { name: fromName, address: from }, to, subject, text, html, attachments });
      return { messageId: info.messageId };
    },
  };
}

/**
 * Transporte por la pasarela PHP del cPanel (public/correo/enviar.php).
 * Firma cada petición con HMAC-SHA256(secreto, timestamp + "." + cuerpo).
 */
export function crearTransportePasarela({ url, secret, fetchImpl = fetch, timeoutMs = 30000 }) {
  return {
    async send({ to, subject, text, html, attachments = [] }) {
      const cuerpo = JSON.stringify({
        to, subject, text, html,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          contentBase64: Buffer.from(a.content).toString("base64"),
        })),
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const firma = createHmac("sha256", secret).update(`${ts}.${cuerpo}`).digest("hex");
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HCGA-Timestamp": ts, "X-HCGA-Signature": firma },
        body: cuerpo,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(`pasarela de correo: HTTP ${r.status} ${d.error || ""} ${d.detail || ""}`.trim());
      return { messageId: d.messageId };
    },
  };
}
