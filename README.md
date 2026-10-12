# HCGA · Certificados (backend)

Servicio Node.js de **HCGA Trading LLC** que genera el **Certificado Digital de
Intención Comercial** en PDF a partir de la plantilla oficial y de los datos del
cliente guardados en Supabase.

Cada PDF se guarda en dos sitios:

1. `storage/certificados/<año>/<CUI>/CERT-<CUI>-v<n>.pdf` en el disco del servidor, y
2. el bucket privado `certificados` de Supabase Storage (copia de referencia).

La tabla `public.certificates` registra la ruta, el tamaño, la huella SHA-256 y
cuándo se guardó cada copia. Si la copia local se pierde (por ejemplo, el disco
se vacía al redesplegar), se restaura sola desde Supabase la siguiente vez que se
pide ese certificado.

Al emitirlo, envía automáticamente al titular (desde `ing.alberto@hcgatrading.com`)
el correo de **confirmación del registro** con el **certificado PDF adjunto** y un
botón para confirmar su correo (`confirmar.html`). Se envía una sola vez; si falla
se reintenta en la siguiente petición (máx. 5 intentos). El estado queda en
`certificates.email_status` / `email_sent_at` / `email_error`.

## Estructura

```
src/
  server.js        Servidor HTTP, conexión con Supabase y carpeta local
  handler.js       Lógica de emisión (validación, idempotencia, errores)
  certificado.js   Composición del PDF: posiciones, texto, sello y QR
  correo.js        Correo automático (español/inglés) y envío SMTP
  plantilla.js     Plantilla oficial (página 1, sin marcadores), en base64
supabase/
  registrations.sql  Esquema completo de la base de datos (idempotente)
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/certificados/emitir` | `{ "cui": "...", "token": "..." }` → genera o recupera el PDF y devuelve un enlace de descarga firmado (1 hora) |
| `GET` | `/health` | Estado del servicio |

Solo quien tiene el token del certificado (el propio cliente, que lo recibe de
`register_interest()` al registrarse) puede pedirlo. Pedirlo otra vez no lo
regenera: el documento no cambia después de entregarse.

Límites: 30 peticiones por minuto por IP y 16 KB por petición. CORS restringido a
`ALLOWED_ORIGINS`.

## Flujo completo

1. El formulario web (`formulario-registro.html`, repositorio del sitio) registra
   al cliente con `register_interest()` en Supabase, que crea el registro y su
   certificado v1.
2. El formulario llama a este servicio con el código y el token del certificado.
3. El servicio genera el PDF, lo guarda en los dos sitios y devuelve el enlace.
4. El QR del certificado lleva a `verificar.html`, que consulta
   `verify_certificate()` en Supabase.

## Variables de entorno

| Variable | Obligatoria | Valor |
|---|---|---|
| `SUPABASE_URL` | Sí | `https://nhyovijaojrcowgxbaif.supabase.co` |
| `SUPABASE_SECRET_KEY` | Sí | Supabase → Project Settings → API Keys → **Secret key** (`sb_secret_...`) |
| `ALLOWED_ORIGINS` | No | Por defecto `https://hcgatrading.com,https://www.hcgatrading.com` |
| `CERT_STORAGE_DIR` | No | Por defecto `storage/certificados` dentro de la app |
| `MAIL_USER` | Para el correo | `ing.alberto@hcgatrading.com` |
| `MAIL_PASS` | Para el correo | Contraseña del buzón (secreta) |
| `MAIL_HOST` / `MAIL_PORT` | No | Por defecto `smtp.office365.com` / `587` |
| `MAIL_FROM` / `MAIL_FROM_NAME` | No | Por defecto `MAIL_USER` / `HCGA Trading LLC` |
| `PORT` | No | Lo asigna la plataforma |

Sin `MAIL_USER`/`MAIL_PASS` el correo automático queda desactivado y todo lo demás sigue funcionando.
El buzón es de Microsoft 365 contratado en GoDaddy: requiere activar **Autenticación SMTP**
en GoDaddy → Email y Office → Administrar → Opciones avanzadas.

La clave secreta da acceso total a la base de datos: solo va en las variables de
entorno del hosting, nunca en el código, en el repositorio ni en un chat.

## Base de datos

Ejecuta `supabase/registrations.sql` completo en Supabase → SQL Editor. Es
idempotente: se puede volver a ejecutar sin perder datos. Crea las tablas
`registrations`, `certificates` y `settings`, el bucket privado `certificados`,
las funciones públicas (`register_interest`, `public_stats`, `verify_certificate`,
`verify_registration`) y la vista `certificates_overview`.

## Publicar en GoDaddy (Node.js Apps)

Incluido en el plan de Web Hosting (Deluxe: 10 apps publicadas).

**Opción recomendada: conectar este repositorio.** GoDaddy → **Node.js Apps → Add App**
→ conecta GitHub y elige este repositorio y la rama `main`. Cada `git push` a `main`
se despliega automáticamente.

**Alternativa: subir un zip** (máx. 100 MB) sin `node_modules`, `.env` ni `storage/`.

En ambos casos:

1. Elige la región **North America** (Supabase está en `us-east-1`).
2. Añade las variables de entorno (*"I need to add secrets for my app to boot"*).
3. GoDaddy ejecuta `npm install`, `npm run build` y `npm start`.
4. Revisa la vista previa privada, publica y conecta **solo el subdominio**
   `certificados.hcgatrading.com`. No conectes `hcgatrading.com`: es el sitio en cPanel.
5. Comprueba `https://certificados.hcgatrading.com/health`.

Correo desde GoDaddy: según las reglas publicadas de Node.js Hosting, las apps solo
pueden salir por HTTP/HTTPS, por lo que el SMTP (puerto 587) podría estar bloqueado
allí. Compruébalo tras publicar: si el registro devuelve `email_status: "error"` con un
error de conexión, hay que cambiar el transporte de `correo.js` (por ejemplo, envío
desde el cPanel con el relé de GoDaddy) sin tocar el resto.

Reglas de GoDaddy que esta app ya cumple: `package.json` en la raíz con `name`,
`version`, `main`, `build` y `start`; puerto desde `process.env.PORT`; dependencias
en `dependencies`; lockfile incluido; salida a internet solo por HTTPS (Supabase).

Sobre el disco: GoDaddy indica que los archivos que deben sobrevivir entre
despliegues se escriban en `/public/assets/`, pero no aclara si esa carpeta es
pública. Hasta confirmarlo con su soporte, no la uses para certificados: la copia
de Supabase y la restauración automática cubren la pérdida de la copia local.

## Consultar los certificados

- **Supabase:** Storage → `certificados`, o la vista `certificates_overview`
  (cliente, estado, ruta, tamaño y fechas de cada copia).
- **Servidor:** carpeta `storage/certificados/` de la app.

## Desarrollo local

```bash
npm install
cp .env.example .env   # y rellena SUPABASE_SECRET_KEY
node --env-file=.env src/server.js
```

## Plantilla del certificado

`src/plantilla.js` se genera desde el PDF original (2 páginas; la segunda es una
hoja interna que nunca se publica) con el script `scripts/certificado/preparar-plantilla.cjs`
del repositorio del sitio web (`npm run certificado:plantilla`). Ese script quita los
marcadores `{{...}}` de la capa de texto y conserva solo la página 1.
