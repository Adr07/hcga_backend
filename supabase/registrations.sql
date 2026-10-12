-- =====================================================================
-- HCGA · Registro de Interés y Certificado Digital de Intención Comercial
-- (public/formulario-registro.html + certificados-app/, app Node.js en GoDaddy)
--
-- Ejecutar completo en Supabase → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a ejecutar sin perder datos.
--
-- Modelo
--   registrations   1 ──< certificates          (un registro, N versiones de certificado)
--   certificates.storage_path → bucket privado "certificados" de Supabase Storage
--                               y copia en storage/certificados/ del servidor Node.js
--
-- Seguridad
--   * Las tablas tienen RLS activado y SIN políticas: el navegador (rol anon)
--     no puede leer, modificar ni borrar nada directamente.
--   * El formulario solo puede llamar a funciones concretas:
--       register_interest()   alta + certificado v1 pendiente de generar
--       public_stats()        cifras agregadas
--       verify_certificate()  página pública del QR
--       verify_registration() confirmación del correo
--   * El PDF lo genera la app Node.js "certificados-app" (GoDaddy) con la clave
--     secreta de Supabase. El bucket es privado: los enlaces de descarga son
--     URLs firmadas que caducan, por eso en la tabla se guarda la RUTA del
--     archivo y no una URL.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Utilidades
-- ---------------------------------------------------------------------

-- Token aleatorio de 32 caracteres sin I, L, O, 0, 1 (~157 bits).
-- Mismo formato que usaba hcga-registro (utils/ids.js) para el QR.
create or replace function public.hcga_token(p_len int default 32)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alfabeto constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(p_len);
  salida text := '';
begin
  for i in 0 .. p_len - 1 loop
    salida := salida || substr(alfabeto, (get_byte(bytes, i) % 30) + 1, 1);
  end loop;
  return salida;
end;
$$;

revoke all on function public.hcga_token(int) from public, anon, authenticated;

-- Ajustes que se imprimen en el certificado (editables desde Table Editor).
create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into public.settings (key, value) values
  ('public_origin', 'https://hcgatrading.com'),   -- base de la URL de verificación del QR
  ('company_identification', ''),                 -- "IDENTIFICACIÓN EMPRESARIAL" de HCGA; vacío = "—"
  ('certificate_template_version', 'v4')
on conflict (key) do nothing;

alter table public.settings enable row level security;
revoke all on table public.settings from anon, authenticated;

create or replace function public.hcga_setting(p_key text)
returns text
language sql
stable
set search_path = ''
as $$ select s.value from public.settings s where s.key = p_key $$;

revoke all on function public.hcga_setting(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 1. Registros (datos completos del formulario)
-- ---------------------------------------------------------------------
create table if not exists public.registrations (
  id                       uuid primary key default gen_random_uuid(),
  cui                      text not null unique,                 -- HCGA-CI-2026-123456
  status                   text not null default 'registered'
                             check (status in ('registered', 'verified', 'rejected', 'withdrawn')),

  -- Datos principales
  role                     text not null check (role in ('carrier', 'shipper')),
  name                     text not null check (char_length(name) between 2 and 120),
  id_type                  text not null check (id_type in ('USDOT', 'MC', 'EIN', 'WEB')),
  id_value                 text not null check (char_length(id_value) between 1 and 120),
  email                    text not null check (char_length(email) <= 160
                                                and email ~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  phone                    text not null check (char_length(phone) <= 30),

  -- Opcional: "ayúdenos a estimar el potencial"
  trucks                   integer check (trucks between 1 and 999),               -- carrier
  equipment                text check (equipment in ('straight_26ft', 'straight_16_24ft', 'cargo_van', 'tractor_53ft', 'other')),
  states                   text check (char_length(states) <= 60),                 -- carrier
  loads_per_month          integer check (loads_per_month between 0 and 9999),
  load_board               text check (load_board in ('none', 'dat', 'truckstop', 'other')), -- carrier
  load_board_cost          integer check (load_board_cost between 0 and 9999),     -- carrier, USD/mes
  membership_interest      text check (membership_interest in ('yes', 'no', 'depends')), -- carrier
  lanes                    text check (char_length(lanes) <= 120),                 -- shipper
  uses_brokers             text check (uses_brokers in ('yes', 'no', 'sometimes')), -- shipper
  avg_rate                 integer check (avg_rate between 0 and 99999),           -- shipper, USD

  -- Autorizaciones
  consent_terms            boolean not null check (consent_terms),     -- obligatoria
  consent_contact          boolean not null check (consent_contact),   -- obligatoria
  consent_public_listing   boolean not null default false,
  consent_share_financiers boolean not null default false,
  text_version_certificate text,
  text_version_consents    text,

  -- Metadatos
  language                 text not null default 'es' check (language in ('es', 'en')),
  source                   text check (char_length(source) <= 40),
  user_agent               text check (char_length(user_agent) <= 500),
  ip                       inet,
  created_at               timestamptz not null default now(),
  verified_at              timestamptz,
  verification_token       text unique,                          -- enlace de confirmación del correo
  verification_expires_at  timestamptz,

  -- Carrier se identifica con USDOT/MC; Shipper con EIN/sitio web
  constraint registrations_id_type_matches_role check (
    (role = 'carrier' and id_type in ('USDOT', 'MC')) or
    (role = 'shipper' and id_type in ('EIN', 'WEB'))
  ),
  -- Un mismo correo solo puede registrarse una vez por rol
  constraint registrations_email_role_key unique (email, role)
);

-- Una versión intermedia de este script guardaba el token del QR aquí; ahora
-- vive en certificates.verification_token.
alter table public.registrations drop column if exists qr_token;

create index if not exists registrations_created_at_idx on public.registrations (created_at desc);
create index if not exists registrations_ip_created_idx on public.registrations (ip, created_at);
create index if not exists registrations_status_idx     on public.registrations (status);

comment on table public.registrations is
  'Registros de interés del formulario público (datos completos, no se imprimen).';

alter table public.registrations enable row level security;
revoke all on table public.registrations from anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. Certificados (lo que se imprime + dónde está el PDF)
--    Las columnas holder_* y company_identification son una FOTO de lo que
--    se imprimió: el PDF no cambia después de entregarse (hoja interna de la
--    plantilla), así que el registro tampoco debe cambiar.
-- ---------------------------------------------------------------------
create table if not exists public.certificates (
  id                      uuid primary key default gen_random_uuid(),
  registration_id         uuid not null references public.registrations (id) on delete restrict,
  version                 integer not null default 1 check (version >= 1),

  -- Campos del documento
  cui                     text not null,                                   -- CÓDIGO ÚNICO / DOCUMENTO N.º
  issued_at               timestamptz not null default now(),              -- FECHA Y HORA DE EMISIÓN
  status                  text not null default 'registered'               -- ESTADO / ESTADO DEL CERTIFICADO
                            check (status in ('registered', 'verified', 'revoked')),
  verified_at             timestamptz,                                     -- FECHA DE VERIFICACIÓN
  company_identification  text not null default '',                        -- IDENTIFICACIÓN EMPRESARIAL
  holder_name             text not null,                                   -- NOMBRE / RAZÓN SOCIAL
  holder_id_masked        text not null,                                   -- IDENTIFICACIÓN (ÚLTIMOS 4)
  holder_role             text not null check (holder_role in ('carrier', 'shipper')), -- ROL
  holder_email_masked     text not null,                                   -- CORREO ELECTRÓNICO
  holder_phone_masked     text not null,                                   -- TELÉFONO
  verification_token      text not null unique default public.hcga_token(32), -- va dentro del QR
  verification_url        text not null,                                   -- URL O MECANISMO DE CONSULTA
  seal                    text not null,                                   -- SELLO DIGITAL
  template_version        text not null default 'v4',

  -- Archivo PDF en Storage
  generation_status       text not null default 'pending'
                            check (generation_status in ('pending', 'generated', 'error')),
  storage_bucket          text not null default 'certificados',
  storage_path            text unique,                                     -- 2026/HCGA-CI-2026-123456/CERT-...-v1.pdf
  file_size               integer check (file_size > 0),
  file_sha256             text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at            timestamptz,
  generation_attempts     integer not null default 0,
  generation_error        text,
  local_stored_at         timestamptz,                                     -- copia en storage/certificados/ del servidor

  revoked_at              timestamptz,
  revocation_reason       text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint certificates_version_key unique (registration_id, version),
  constraint certificates_generated_has_file check (
    generation_status <> 'generated' or (storage_path is not null and file_size is not null and file_sha256 is not null)
  )
);

alter table public.certificates add column if not exists local_stored_at timestamptz;

-- Solo un certificado vigente por registro.
create unique index if not exists certificates_one_active_idx
  on public.certificates (registration_id) where status <> 'revoked';
create index if not exists certificates_cui_idx        on public.certificates (cui);
create index if not exists certificates_generation_idx on public.certificates (generation_status);

comment on table public.certificates is
  'Certificados Digitales de Intención Comercial emitidos. storage_path apunta al PDF en el bucket privado "certificados".';

alter table public.certificates enable row level security;
revoke all on table public.certificates from anon, authenticated;

create or replace function public.hcga_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists certificates_touch_updated_at on public.certificates;
create trigger certificates_touch_updated_at
  before update on public.certificates
  for each row execute function public.hcga_touch_updated_at();

-- Emite (registra) la siguiente versión del certificado de un registro.
-- Calcula los datos enmascarados exactamente como los define la plantilla:
--   identificación ••••1234 · correo j•••@empresa.com · teléfono •••-•••-4567
create or replace function public.hcga_issue_certificate(p_registration_id uuid)
returns public.certificates
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       public.registrations;
  c       public.certificates;
  v_token text := public.hcga_token(32);
  v_now   timestamptz := now();
  v_ver   integer;
begin
  select * into r from public.registrations where id = p_registration_id;
  if r.id is null then raise exception 'registration_not_found'; end if;

  -- Una nueva versión sustituye a la vigente.
  update public.certificates
     set status = 'revoked', revoked_at = v_now, revocation_reason = coalesce(revocation_reason, 'reissued')
   where registration_id = r.id and status <> 'revoked';

  select coalesce(max(version), 0) + 1 into v_ver from public.certificates where registration_id = r.id;

  insert into public.certificates (
    registration_id, version, cui, issued_at, status, verified_at,
    company_identification, holder_name, holder_id_masked, holder_role,
    holder_email_masked, holder_phone_masked,
    verification_token, verification_url, seal, template_version
  ) values (
    r.id, v_ver, r.cui, v_now,
    case when r.status = 'verified' then 'verified' else 'registered' end,
    r.verified_at,
    coalesce(public.hcga_setting('company_identification'), ''),
    r.name,
    case when r.id_type = 'WEB' then regexp_replace(r.id_value, '/.*$', '')
         else r.id_type || ' ••••' || right(regexp_replace(r.id_value, '\D', '', 'g'), 4) end,
    r.role,
    left(r.email, 1) || '•••' || substr(r.email, strpos(r.email, '@')),
    '•••-•••-' || right(regexp_replace(r.phone, '\D', '', 'g'), 4),
    v_token,
    rtrim(coalesce(public.hcga_setting('public_origin'), 'https://hcgatrading.com'), '/') || '/verificar.html?t=' || v_token,
    -- Sello = SHA-256(código | token | emisión), como en hcga-registro.
    'HCGA-SELLO-' || upper(left(encode(sha256(convert_to(
        r.cui || '|' || v_token || '|' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'UTF8')), 'hex'), 24)),
    coalesce(public.hcga_setting('certificate_template_version'), 'v4')
  )
  returning * into c;

  return c;
end;
$$;

revoke all on function public.hcga_issue_certificate(uuid) from public, anon, authenticated;

-- Registros anteriores sin certificado (p. ej. los creados antes de este script).
do $$
declare r record;
begin
  for r in select g.id from public.registrations g
            where not exists (select 1 from public.certificates c where c.registration_id = g.id)
  loop
    perform public.hcga_issue_certificate(r.id);
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 3. Storage: bucket PRIVADO para los PDF
--    Sin políticas sobre storage.objects: solo la clave secreta (la app de
--    certificados) y el panel de Supabase pueden leer o escribir.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('certificados', 'certificados', false, 1048576, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------------------
-- 4. Alta desde el formulario (única puerta de entrada pública)
--    Recibe el JSON de buildPayload(). Crea el registro y su certificado v1
--    en la misma transacción. Devuelve el token del certificado al propio
--    titular: con él la app de certificados genera y entrega su PDF.
-- ---------------------------------------------------------------------
drop function if exists public.register_interest(jsonb);
create function public.register_interest(payload jsonb)
returns table (cui text, status text, created_at timestamptz, certificate_token text, certificate_version integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role     text := lower(trim(payload->>'role'));
  v_name     text := trim(payload->>'name');
  v_id_type  text := upper(trim(payload->>'idType'));
  v_id_value text := trim(payload->>'idValue');
  v_email    text := lower(trim(payload->>'email'));
  v_phone    text := trim(payload->>'phone');
  v_opt      jsonb := coalesce(payload->'optional', '{}'::jsonb);
  v_cons     jsonb := coalesce(payload->'consents', '{}'::jsonb);
  v_lang     text := lower(coalesce(payload->>'language', 'es'));
  v_digits   text;
  v_phone_d  text := regexp_replace(coalesce(payload->>'phone', ''), '\D', '', 'g');
  v_ip       inet;
  v_cui      text;
  v_row      public.registrations;
  v_cert     public.certificates;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;

  -- IP real del visitante (PostgREST reenvía las cabeceras HTTP)
  begin
    v_ip := nullif(trim(split_part(
              current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1)), '')::inet;
  exception when others then
    v_ip := null;
  end;

  -- Anti-spam: máximo 5 registros por IP por hora
  if v_ip is not null and (
       select count(*) from public.registrations r
       where r.ip = v_ip and r.created_at > now() - interval '1 hour'
     ) >= 5 then
    raise exception 'rate_limited';
  end if;

  -- Validaciones (las mismas reglas que el formulario)
  if v_role not in ('carrier', 'shipper') then raise exception 'invalid_role'; end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'invalid_name';
  end if;

  if v_role = 'carrier' and v_id_type = 'USDOT' then
    v_digits := regexp_replace(regexp_replace(v_id_value, '^(usdot|dot)[\s-]*', '', 'i'), '\D', '', 'g');
    if v_digits !~ '^\d{5,8}$' then raise exception 'invalid_usdot'; end if;
    v_id_value := v_digits;
  elsif v_role = 'carrier' and v_id_type = 'MC' then
    v_digits := regexp_replace(regexp_replace(v_id_value, '^mc[\s-]*', '', 'i'), '\D', '', 'g');
    if v_digits !~ '^\d{5,7}$' then raise exception 'invalid_mc'; end if;
    v_id_value := 'MC-' || v_digits;
  elsif v_role = 'shipper' and v_id_type = 'EIN' then
    if v_id_value !~ '^\d{2}-?\d{7}$' then raise exception 'invalid_ein'; end if;
    v_digits := regexp_replace(v_id_value, '\D', '', 'g');
    v_id_value := substr(v_digits, 1, 2) || '-' || substr(v_digits, 3);
  elsif v_role = 'shipper' and v_id_type = 'WEB' then
    if v_id_value !~* '^(https?://)?([a-z0-9-]+\.)+[a-z]{2,}(/\S*)?$' then raise exception 'invalid_website'; end if;
    v_id_value := lower(regexp_replace(v_id_value, '^https?://', '', 'i'));
  else
    raise exception 'invalid_id_type';
  end if;

  if v_email is null or v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 160 then
    raise exception 'invalid_email';
  end if;

  if v_phone is null or char_length(v_phone) > 30 or not (
       char_length(v_phone_d) = 10
    or (char_length(v_phone_d) = 11 and left(v_phone_d, 1) = '1')
    or (v_phone ~ '^\s*\+' and char_length(v_phone_d) between 8 and 15)
  ) then
    raise exception 'invalid_phone';
  end if;

  if coalesce((v_cons->>'terms')::boolean, false) is not true
     or coalesce((v_cons->>'contact')::boolean, false) is not true then
    raise exception 'consent_required';
  end if;

  if v_lang not in ('es', 'en') then v_lang := 'es'; end if;

  if exists (select 1 from public.registrations r where r.email = v_email and r.role = v_role) then
    raise exception 'already_registered';
  end if;

  -- CUI único generado en el servidor
  loop
    v_cui := 'HCGA-CI-' || extract(year from now())::int || '-'
             || (100000 + floor(random() * 900000))::int;
    exit when not exists (select 1 from public.registrations r where r.cui = v_cui);
  end loop;

  insert into public.registrations (
    cui, role, name, id_type, id_value, email, phone,
    trucks, equipment, states, loads_per_month, load_board, load_board_cost,
    membership_interest, lanes, uses_brokers, avg_rate,
    consent_terms, consent_contact, consent_public_listing, consent_share_financiers,
    text_version_certificate, text_version_consents,
    language, source, user_agent, ip,
    verification_token, verification_expires_at
  ) values (
    v_cui, v_role, v_name, v_id_type, v_id_value, v_email, v_phone,
    -- Campos opcionales: se guardan solo si tienen un valor válido
    case when v_opt->>'trucks'    ~ '^\d{1,3}$' then nullif((v_opt->>'trucks')::int, 0) end,
    case when v_opt->>'equip' in ('straight_26ft', 'straight_16_24ft', 'cargo_van', 'tractor_53ft', 'other') then v_opt->>'equip' end,
    case when v_role = 'carrier' then nullif(left(trim(v_opt->>'states'), 60), '') end,
    case when v_opt->>'loads'     ~ '^\d{1,4}$' then (v_opt->>'loads')::int end,
    case when v_role = 'carrier' and v_opt->>'board' in ('none', 'dat', 'truckstop', 'other') then v_opt->>'board' end,
    case when v_role = 'carrier' and v_opt->>'boardCost' ~ '^\d{1,4}$' then (v_opt->>'boardCost')::int end,
    case when v_role = 'carrier' and v_opt->>'member' in ('yes', 'no', 'depends') then v_opt->>'member' end,
    case when v_role = 'shipper' then nullif(left(trim(v_opt->>'lanes'), 120), '') end,
    case when v_role = 'shipper' and v_opt->>'brokers' in ('yes', 'no', 'sometimes') then v_opt->>'brokers' end,
    case when v_role = 'shipper' and v_opt->>'avgRate' ~ '^\d{1,5}$' then (v_opt->>'avgRate')::int end,
    true, true,
    coalesce((v_cons->>'publicListing')::boolean, false),
    coalesce((v_cons->>'shareWithFinanciers')::boolean, false),
    left(payload->'textVersions'->>'certificate', 20),
    left(payload->'textVersions'->>'consents', 20),
    v_lang,
    left(regexp_replace(coalesce(payload->>'source', 'web'), '[^\w-]', '', 'g'), 40),
    left(payload->>'userAgent', 500),
    v_ip,
    public.hcga_token(32),
    now() + interval '7 days'
  )
  returning * into v_row;

  v_cert := public.hcga_issue_certificate(v_row.id);

  return query select v_row.cui, v_row.status, v_row.created_at, v_cert.verification_token, v_cert.version;
end;
$$;

revoke all on function public.register_interest(jsonb) from public;
grant execute on function public.register_interest(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. Confirmación del correo (enlace "Le enviaremos un enlace para confirmarlo")
--    Pasa el registro y su certificado vigente a "verified".
-- ---------------------------------------------------------------------
create or replace function public.verify_registration(p_token text)
returns table (cui text, status text, verified_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.registrations;
begin
  update public.registrations r
     set status = 'verified',
         verified_at = now(),
         verification_token = null,
         verification_expires_at = null
   where r.verification_token = p_token
     and r.verification_expires_at > now()
     and r.status = 'registered'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'invalid_or_expired_token';
  end if;

  update public.certificates c
     set status = 'verified', verified_at = v_row.verified_at
   where c.registration_id = v_row.id and c.status = 'registered';

  return query select v_row.cui, v_row.status, v_row.verified_at;
end;
$$;

revoke all on function public.verify_registration(text) from public;
grant execute on function public.verify_registration(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. Contadores públicos (sección "Cuántas personas se han sumado")
--    Solo cifras agregadas. Cuentan "registered" + "verified";
--    "verified" se devuelve aparte (cifra para financiadores).
-- ---------------------------------------------------------------------
create or replace function public.public_stats()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'total',      count(*) filter (where r.status in ('registered', 'verified')),
    'verified',   count(*) filter (where r.status = 'verified'),
    'carriers',   count(*) filter (where r.status in ('registered', 'verified') and r.role = 'carrier'),
    'shippers',   count(*) filter (where r.status in ('registered', 'verified') and r.role = 'shipper'),
    'updated_at', now()
  )
  from public.registrations r;
$$;

revoke all on function public.public_stats() from public;
grant execute on function public.public_stats() to anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. Verificación pública del certificado (la página que abre el QR)
--    Solo lo que promete la plantilla: código, fecha, rol, estado y el
--    nombre ÚNICAMENTE si el titular autorizó su publicación.
-- ---------------------------------------------------------------------
drop function if exists public.verify_certificate(text);
create function public.verify_certificate(p_token text)
returns table (cui text, version integer, role text, public_name text, status text,
               issued_at timestamptz, verified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.cui,
         c.version,
         c.holder_role,
         case when r.consent_public_listing then c.holder_name end,
         case when r.status in ('rejected', 'withdrawn') then 'revoked' else c.status end,
         c.issued_at,
         c.verified_at
    from public.certificates c
    join public.registrations r on r.id = c.registration_id
   where p_token ~ '^[A-Z2-9]{32}$'
     and c.verification_token = p_token;
$$;

revoke all on function public.verify_certificate(text) from public;
grant execute on function public.verify_certificate(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 8. Vista para el panel (Table Editor / SQL): registro + certificado vigente
--    security_invoker: respeta los permisos de quien consulta (anon no ve nada).
-- ---------------------------------------------------------------------
drop view if exists public.certificates_overview;
create view public.certificates_overview
with (security_invoker = true) as
select c.cui,
       c.version,
       r.name,
       r.role,
       r.email,
       r.status            as registration_status,
       c.status            as certificate_status,
       c.issued_at,
       c.generation_status,
       c.storage_bucket,
       c.storage_path,
       c.file_size,
       c.generated_at,
       c.local_stored_at,
       c.verification_url
  from public.certificates c
  join public.registrations r on r.id = c.registration_id;

revoke all on public.certificates_overview from anon, authenticated;


-- ---------------------------------------------------------------------
-- 9. Prueba rápida (opcional): descomentar, ejecutar y luego borrar las filas.
-- ---------------------------------------------------------------------
-- select * from public.register_interest('{
--   "role": "carrier", "name": "Transportes Prueba LLC",
--   "idType": "USDOT", "idValue": "1234567",
--   "email": "prueba@example.com", "phone": "(239) 555-0123",
--   "consents": { "terms": true, "contact": true },
--   "language": "es", "source": "web"
-- }'::jsonb);
-- delete from public.certificates where cui in (select cui from public.registrations where email = 'prueba@example.com');
-- delete from public.registrations where email = 'prueba@example.com';
