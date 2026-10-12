/*
 * POST /api/certificados/emitir   { "cui": "...", "token": "..." }
 *
 * Genera el PDF del certificado (si aún no existe) y lo guarda en dos sitios:
 *   1. storage/certificados/<ruta> en el disco del servidor (copia local, como
 *      en el sistema hcga-registro), y
 *   2. el bucket privado "certificados" de Supabase (copia de referencia).
 * Registra ruta + tamaño + SHA-256 en public.certificates y devuelve una URL
 * firmada de descarga. La copia de Supabase es obligatoria; la local se
 * intenta siempre y, si falta (p. ej. el disco se vació al redesplegar), se
 * restaura desde Supabase en la siguiente petición.
 *
 * Después envía al titular el correo de confirmación del registro con el PDF
 * adjunto (una sola vez; si falla se reintenta en la siguiente petición, hasta
 * MAX_INTENTOS_CORREO). Un fallo del correo nunca impide entregar el certificado.
 *
 * Quién puede llamarla: solo quien tiene el token del certificado, que
 * register_interest() devuelve únicamente al titular. Es idempotente: si el PDF
 * ya existe no se vuelve a generar (el documento no cambia tras entregarse).
 *
 * Usa la interfaz estándar Request/Response: server.js le inyecta Supabase
 * (base de datos + Storage), la carpeta local y el generador, y las pruebas
 * le inyectan dobles.
 */

import { redactarCorreo } from "./correo.js";

const TOKEN_RE = /^[A-Z2-9]{32}$/;
const CUI_RE = /^HCGA-CI-\d{4}-[A-Z0-9]{6}$/;
const URL_TTL_SECONDS = 60 * 60; // la URL firmada caduca en 1 hora
const MAX_INTENTOS_CORREO = 5;

export function rutaDe(c) {
  return `${new Date(c.issued_at).getUTCFullYear()}/${c.cui}/CERT-${c.cui}-v${c.version}.pdf`;
}

export function createHandler(deps) {
  const allowed = deps.allowedOrigins || [];

  function cors(req) {
    const origin = req.headers.get("origin") || "";
    return {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  function json(req, status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Copia local: nunca bloquea la respuesta; un fallo queda en el log y en
  // local_stored_at = null, y se reintenta en la siguiente petición.
  async function guardarLocal(c, ruta, pdf) {
    if (!deps.local) return false;
    try {
      await deps.local.save(ruta, pdf);
      return true;
    } catch (e) {
      deps.log?.("copia local no guardada", c.cui, e?.message || e);
      return false;
    }
  }
  async function restaurarLocal(c) {
    if (!deps.local || await deps.local.exists(c.storage_path)) return c;
    try {
      const pdf = await deps.download(c.storage_bucket, c.storage_path);
      if (await guardarLocal(c, c.storage_path, pdf)) return await deps.markLocal(c.id);
    } catch (e) {
      deps.log?.("copia local no restaurada", c.cui, e?.message || e);
    }
    return c;
  }

  async function leerPdf(c) {
    if (deps.local && await deps.local.exists(c.storage_path)) return deps.local.read(c.storage_path);
    return deps.download(c.storage_bucket, c.storage_path);
  }

  // Devuelve el estado del correo tras intentar enviarlo: sent | sending | error | pending | disabled
  async function enviarCorreo(c, pdf) {
    if (!deps.mail) return "disabled";
    if (c.email_status === "sent") return "sent";
    if ((c.email_attempts || 0) >= MAX_INTENTOS_CORREO) return c.email_status;
    // Reserva atómica: si dos peticiones llegan a la vez, solo una envía.
    if (!await deps.claimEmail(c)) return c.email_status === "error" ? "error" : "sending";
    try {
      const titular = await deps.findHolder(c.registration_id);
      if (!titular) throw new Error("titular no encontrado");
      const mensaje = redactarCorreo({ certificado: c, titular, pdf: pdf || await leerPdf(c) });
      await deps.mail.send(mensaje);
      await deps.markEmail(c.id, { status: "sent" });
      return "sent";
    } catch (e) {
      deps.log?.("correo no enviado", c.cui, e?.message || e);
      await deps.markEmail(c.id, { status: "error", error: String(e?.message || e).slice(0, 500) });
      return "error";
    }
  }

  async function firmar(req, c, emailStatus) {
    const url = await deps.signedUrl(c.storage_bucket, c.storage_path, URL_TTL_SECONDS, `CERT-${c.cui}.pdf`);
    return json(req, 200, {
      cui: c.cui,
      version: c.version,
      status: c.status,
      verification_url: c.verification_url,
      email_status: emailStatus,
      download_url: url,
      expires_in: URL_TTL_SECONDS,
    });
  }

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

    let body;
    try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_json" }); }
    const token = String(body?.token || "").trim().toUpperCase();
    const cui = String(body?.cui || "").trim().toUpperCase();
    if (!TOKEN_RE.test(token) || !CUI_RE.test(cui)) return json(req, 400, { error: "invalid_request" });

    const c = await deps.findCertificate(token);
    // Mismo error si el token no existe o no corresponde al código: no se
    // revela qué parte es incorrecta.
    if (!c || c.cui !== cui) return json(req, 404, { error: "not_found" });
    if (c.status === "revoked") return json(req, 410, { error: "revoked" });

    if (c.generation_status === "generated" && c.storage_path) {
      const actual = await restaurarLocal(c);
      return firmar(req, actual, await enviarCorreo(actual, null));
    }

    const ruta = rutaDe(c);
    try {
      const pdf = await deps.generate(c);
      const local = await guardarLocal(c, ruta, pdf);
      // upsert: si dos peticiones simultáneas llegan aquí, la última escribe el
      // archivo y también sus metadatos, así que ambos siempre coinciden.
      const subida = await deps.upload(c.storage_bucket, ruta, pdf);
      if (!subida.ok) throw new Error(subida.error || "upload_failed");
      const actualizado = await deps.markGenerated(c.id, {
        storage_path: ruta,
        file_size: pdf.byteLength,
        file_sha256: await deps.sha256Hex(pdf),
        attempts: (c.generation_attempts || 0) + 1,
        local_stored: local,
      });
      return firmar(req, actualizado, await enviarCorreo(actualizado, pdf));
    } catch (e) {
      await deps.markError(c.id, String((e && e.message) || e).slice(0, 500), (c.generation_attempts || 0) + 1);
      return json(req, 500, { error: "generation_failed" });
    }
  };
}
