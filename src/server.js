/*
 * HCGA · Servicio de certificados (app Node.js para GoDaddy Node.js Hosting).
 *
 *   POST /api/certificados/emitir   { cui, token }  -> genera/guarda el PDF y devuelve una URL firmada
 *   GET  /health                                     -> comprobación de estado
 *
 * Los datos viven en Supabase: la fila de public.certificates aporta los
 * datos del documento. El PDF se guarda en storage/certificados/ (disco del
 * servidor) y en el bucket privado "certificados" de Supabase.
 *
 * Variables de entorno (en GoDaddy: Settings → Environment variables):
 *   SUPABASE_URL          https://nhyovijaojrcowgxbaif.supabase.co
 *   SUPABASE_SECRET_KEY   clave secreta (sb_secret_...) o service_role. NUNCA en el código.
 *   ALLOWED_ORIGINS       orígenes del formulario, separados por comas
 *   CERT_STORAGE_DIR      carpeta de la copia local (por defecto <app>/storage/certificados)
 *   Correo automático (sin ninguno de los dos modos, se desactiva):
 *   MAIL_RELAY_URL, MAIL_RELAY_SECRET  pasarela PHP del cPanel (recomendado en GoDaddy,
 *                         que bloquea el SMTP saliente de las apps Node.js)
 *   MAIL_USER, MAIL_PASS  SMTP directo (MAIL_HOST/MAIL_PORT, por defecto smtp.office365.com:587)
 *   MAIL_FROM, MAIL_FROM_NAME  remitente para SMTP (por defecto MAIL_USER y "HCGA Trading LLC")
 *   PORT                  lo asigna la plataforma
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile, rename, access, readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as PDFLib from "pdf-lib";
import { generarCertificado } from "./certificado.js";
import { createHandler } from "./handler.js";
import { PLANTILLA_BASE64 } from "./plantilla.js";
import { crearTransporteSmtp, crearTransportePasarela } from "./correo.js";

const qrcode = createRequire(import.meta.url)("qrcode-generator");
const RUTA = "/api/certificados/emitir";
const CUERPO_MAXIMO = 16 * 1024;
const LIMITE_POR_MINUTO = 30; // por IP; el proceso es persistente, basta con memoria

const COLUMNAS = "id, cui, version, status, issued_at, verified_at, company_identification, holder_name, " +
  "holder_id_masked, holder_role, holder_email_masked, holder_phone_masked, verification_url, seal, " +
  "generation_status, generation_attempts, storage_bucket, storage_path, local_stored_at, " +
  "registration_id, email_status, email_attempts";
const CORREO_ATASCADO_MS = 10 * 60 * 1000; // un envío "sending" más antiguo se considera abandonado

export const CARPETA_POR_DEFECTO = fileURLToPath(new URL("../storage/certificados/", import.meta.url));

/** Copia local en disco: storage/certificados/<año>/<CUI>/CERT-<CUI>-v<n>.pdf */
export function carpetaLocal(raiz) {
  const base = path.resolve(raiz);
  const destino = (ruta) => {
    const f = path.resolve(base, ruta);
    // La ruta sale de la base de datos, pero se comprueba igualmente que no salga de la carpeta.
    if (!f.startsWith(base + path.sep)) throw new Error("ruta fuera de la carpeta de certificados");
    return f;
  };
  return {
    raiz: base,
    read: (ruta) => readFile(destino(ruta)),
    async exists(ruta) {
      try { await access(destino(ruta)); return true; } catch { return false; }
    },
    // Escritura atómica: primero .tmp y luego se renombra, así un corte nunca deja un PDF a medias.
    async save(ruta, bytes) {
      const f = destino(ruta);
      await mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, f);
    },
  };
}

/** Dependencias reales: Supabase (base de datos + Storage) y el generador del PDF. */
export function supabaseDeps({ url, secretKey, allowedOrigins, localDir = CARPETA_POR_DEFECTO, mail = null }) {
  const supabase = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const plantilla = Uint8Array.from(Buffer.from(PLANTILLA_BASE64, "base64"));
  return {
    allowedOrigins,
    local: carpetaLocal(localDir),
    mail,
    async claimEmail(c) {
      const atascado = new Date(Date.now() - CORREO_ATASCADO_MS).toISOString();
      const { data, error } = await supabase.from("certificates")
        .update({ email_status: "sending", email_attempts: (c.email_attempts || 0) + 1 })
        .eq("id", c.id)
        .eq("email_attempts", c.email_attempts || 0)
        .or(`email_status.in.(pending,error),and(email_status.eq.sending,updated_at.lt."${atascado}")`)
        .select("id");
      if (error) throw error;
      return data.length === 1;
    },
    async findHolder(registrationId) {
      const { data, error } = await supabase.from("registrations")
        .select("email, name, language, status, verification_token, verification_expires_at")
        .eq("id", registrationId).maybeSingle();
      if (error) throw error;
      return data;
    },
    async markEmail(id, { status, error: mensaje = null }) {
      const { error } = await supabase.from("certificates").update({
        email_status: status,
        email_error: mensaje,
        ...(status === "sent" ? { email_sent_at: new Date().toISOString() } : {}),
      }).eq("id", id);
      if (error) throw error;
    },
    log: (...a) => console.warn("[certificados]", ...a),
    async findCertificate(token) {
      const { data, error } = await supabase.from("certificates").select(COLUMNAS).eq("verification_token", token).maybeSingle();
      if (error) throw error;
      return data;
    },
    generate: (certificado) => generarCertificado({ PDFLib, qrcode, plantilla, certificado }),
    async upload(bucket, path, pdf) {
      const { error } = await supabase.storage.from(bucket).upload(path, pdf, {
        contentType: "application/pdf", cacheControl: "31536000", upsert: true,
      });
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async markGenerated(id, f) {
      const { data, error } = await supabase.from("certificates").update({
        generation_status: "generated",
        storage_path: f.storage_path,
        file_size: f.file_size,
        file_sha256: f.file_sha256,
        generated_at: new Date().toISOString(),
        generation_attempts: f.attempts,
        generation_error: null,
        local_stored_at: f.local_stored ? new Date().toISOString() : null,
      }).eq("id", id).select(COLUMNAS).single();
      if (error) throw error;
      return data;
    },
    async markLocal(id) {
      const { data, error } = await supabase.from("certificates")
        .update({ local_stored_at: new Date().toISOString() }).eq("id", id).select(COLUMNAS).single();
      if (error) throw error;
      return data;
    },
    async download(bucket, ruta) {
      const { data, error } = await supabase.storage.from(bucket).download(ruta);
      if (error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },
    async markError(id, message, attempts) {
      await supabase.from("certificates")
        .update({ generation_status: "error", generation_error: message, generation_attempts: attempts })
        .eq("id", id);
    },
    async signedUrl(bucket, path, ttl, filename) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttl, { download: filename });
      if (error) throw error;
      return data.signedUrl;
    },
    sha256Hex: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  };
}

function ipDe(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0].trim();
}

function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    const trozos = [];
    let total = 0;
    let excedido = false;
    req.on("data", (t) => {
      total += t.length;
      if (excedido) return; // se descarta el resto sin guardarlo
      if (total > CUERPO_MAXIMO) {
        excedido = true;
        // Se responde 413 en vez de cortar la conexión: el cliente recibe un error legible.
        mal(Object.assign(new Error("payload_too_large"), { status: 413 }));
        return;
      }
      trozos.push(t);
    });
    req.on("end", () => { if (!excedido) ok(Buffer.concat(trozos)); });
    req.on("error", mal);
  });
}

/** Servidor HTTP: adapta node:http a la interfaz Request/Response de handler.js. */
export function createServer(deps) {
  const handle = createHandler(deps);
  const visitas = new Map(); // ip -> { inicio, n }

  function json(res, status, body, extra = {}) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return json(res, 200, { ok: true, service: "hcga-certificados" });
      }
      if (url.pathname !== RUTA) return json(res, 404, { error: "not_found" });

      if (req.method === "POST") {
        const ip = ipDe(req), ahora = Date.now();
        const v = visitas.get(ip);
        if (!v || ahora - v.inicio > 60000) visitas.set(ip, { inicio: ahora, n: 1 });
        else if (++v.n > LIMITE_POR_MINUTO) return json(res, 429, { error: "rate_limited" }, { "Retry-After": "60" });
        if (visitas.size > 10000) visitas.clear();
      }

      const cuerpo = req.method === "POST" ? await leerCuerpo(req) : undefined;
      const respuesta = await handle(new Request(new URL(url.pathname, "http://localhost"), {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
        body: cuerpo,
      }));
      res.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
      res.end(Buffer.from(await respuesta.arrayBuffer()));
    } catch (e) {
      if (e && e.status === 413) return json(res, 413, { error: "payload_too_large" }, { Connection: "close" });
      console.error("[certificados]", e);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    }
  });
}

// Arranque directo: `npm start`
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const faltan = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter((k) => !process.env[k]);
  if (faltan.length) {
    console.error(`[certificados] Faltan variables de entorno: ${faltan.join(", ")}`);
    process.exit(1);
  }
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://hcgatrading.com,https://www.hcgatrading.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(process.env.PORT) || 3000;
  const localDir = process.env.CERT_STORAGE_DIR || CARPETA_POR_DEFECTO;
  try {
    await mkdir(localDir, { recursive: true });
  } catch (e) {
    console.warn(`[certificados] No se pudo crear ${localDir}: ${e.message}. Solo se guardará en Supabase.`);
  }
  const mail = process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET
    ? crearTransportePasarela({ url: process.env.MAIL_RELAY_URL, secret: process.env.MAIL_RELAY_SECRET })
    : process.env.MAIL_USER && process.env.MAIL_PASS
    ? crearTransporteSmtp({
      host: process.env.MAIL_HOST || "smtp.office365.com",
      port: Number(process.env.MAIL_PORT) || 587,
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      from: process.env.MAIL_FROM || process.env.MAIL_USER,
      fromName: process.env.MAIL_FROM_NAME || "HCGA Trading LLC",
    })
    : null;
  if (!mail) console.warn("[certificados] Sin MAIL_RELAY_URL/MAIL_RELAY_SECRET ni MAIL_USER/MAIL_PASS: el correo automático está desactivado.");
  else console.log(`[certificados] correo automático por ${process.env.MAIL_RELAY_URL ? "pasarela cPanel" : "SMTP"}`);
  createServer(supabaseDeps({ url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY, allowedOrigins, localDir, mail }))
    .listen(port, () => console.log(`[certificados] escuchando en el puerto ${port}; copias locales en ${path.resolve(localDir)}`));
}
