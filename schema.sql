-- Schéma Supabase commun : chatbot WhatsApp, prospection, suivi de colis
-- À exécuter une seule fois dans l'éditeur SQL du projet.

create extension if not exists pgcrypto;

-- ============================================================
-- Chatbot WhatsApp multi-clients
-- ============================================================

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  phone_number_id text unique not null,
  wa_token text,
  system_prompt text not null default '',
  knowledge_base text not null default '',
  owner_phone text,
  plan text not null default 'standard',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  wa_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  escalated boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists messages_conv_idx on messages (tenant_id, wa_id, id desc);

create or replace function get_chat_context(p_phone_number_id text, p_wa_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t tenants;
  h jsonb;
begin
  select * into t from tenants where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('tenant', null, 'history', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'content', x.content) order by x.id), '[]'::jsonb)
    into h
    from (
      select id, role, content
      from messages
      where tenant_id = t.id and wa_id = p_wa_id
      order by id desc
      limit 10
    ) x;

  return jsonb_build_object('tenant', to_jsonb(t), 'history', h);
end;
$$;

revoke all on function get_chat_context(text, text) from public, anon, authenticated;
grant execute on function get_chat_context(text, text) to service_role;

-- ============================================================
-- Prospection
-- ============================================================

create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  contact_name text,
  email text,
  website text,
  sector text,
  city text,
  country text not null default 'FR',
  offer text not null default 'chatbot' check (offer in ('chatbot', 'suivi_colis')),
  status text not null default 'nouveau'
    check (status in ('nouveau', 'brouillon', 'valide', 'envoye', 'repondu', 'exclu')),
  draft_subject text,
  draft_body text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists prospects_status_idx on prospects (status, created_at);

-- ============================================================
-- Suivi de colis pour transitaires
-- ============================================================

create table if not exists forwarders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id),
  name text not null,
  slug text unique not null,
  phone_number_id text,
  wa_token text,
  brand_color text not null default '#0f4c81',
  contact_phone text,
  created_at timestamptz not null default now()
);

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  forwarder_id uuid not null references forwarders(id) on delete cascade,
  tracking_code text unique not null
    default ('GC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8))),
  client_name text not null,
  client_phone text,
  description text,
  weight_kg numeric(10, 2),
  container_ref text,
  origin text not null default 'Chine',
  destination text not null default 'Libreville',
  status text not null default 'enregistre'
    check (status in ('enregistre', 'recu_entrepot', 'groupage', 'expedie', 'en_transit',
                      'arrive_port', 'dedouanement', 'disponible', 'livre')),
  eta date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shipments_forwarder_idx on shipments (forwarder_id, created_at desc);

create table if not exists shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  status text not null,
  location text,
  note text,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists shipment_events_idx on shipment_events (shipment_id, created_at desc);

-- security definer : l'insertion de l'événement ne dépend pas des politiques RLS
-- de l'utilisateur connecté (aucune politique d'insertion sur shipment_events)
create or replace function shipments_log_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into shipment_events (shipment_id, status) values (new.id, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_event_trg on shipments;
create trigger shipments_event_trg
  after insert or update of status on shipments
  for each row execute function shipments_log_event();

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shipments_touch_trg on shipments;
create trigger shipments_touch_trg
  before update on shipments
  for each row execute function touch_updated_at();

-- Lecture publique d'un colis par son code, sans exposer le téléphone du client
create or replace function track_shipment(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'tracking_code', s.tracking_code,
    'description', s.description,
    'status', s.status,
    'origin', s.origin,
    'destination', s.destination,
    'eta', s.eta,
    'container_ref', s.container_ref,
    'forwarder', jsonb_build_object('name', f.name, 'color', f.brand_color, 'phone', f.contact_phone),
    'events', coalesce((
      select jsonb_agg(
        jsonb_build_object('status', e.status, 'location', e.location, 'note', e.note, 'at', e.created_at)
        order by e.created_at desc, e.id
      )
      from shipment_events e
      where e.shipment_id = s.id
    ), '[]'::jsonb)
  )
  from shipments s
  join forwarders f on f.id = s.forwarder_id
  where s.tracking_code = upper(trim(p_code));
$$;

grant execute on function track_shipment(text) to anon, authenticated;

-- Détails nécessaires à la notification WhatsApp (réservé au workflow n8n)
create or replace function get_shipment_notification(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'event', to_jsonb(e),
    'shipment', to_jsonb(s),
    'forwarder', jsonb_build_object(
      'name', f.name,
      'slug', f.slug,
      'phone_number_id', f.phone_number_id,
      'wa_token', f.wa_token
    )
  )
  from shipment_events e
  join shipments s on s.id = e.shipment_id
  join forwarders f on f.id = s.forwarder_id
  where e.id = p_event_id;
$$;

revoke all on function get_shipment_notification(uuid) from public, anon, authenticated;
grant execute on function get_shipment_notification(uuid) to service_role;

-- ============================================================
-- Sécurité (RLS)
-- Les workflows n8n utilisent la clé service_role, qui contourne la RLS.
-- ============================================================

alter table tenants enable row level security;
alter table messages enable row level security;
alter table prospects enable row level security;
alter table forwarders enable row level security;
alter table shipments enable row level security;
alter table shipment_events enable row level security;

drop policy if exists forwarders_owner on forwarders;
create policy forwarders_owner on forwarders
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists shipments_owner on shipments;
create policy shipments_owner on shipments
  for all to authenticated
  using (forwarder_id in (select id from forwarders where owner_id = auth.uid()))
  with check (forwarder_id in (select id from forwarders where owner_id = auth.uid()));

drop policy if exists events_owner on shipment_events;
create policy events_owner on shipment_events
  for select to authenticated
  using (shipment_id in (
    select s.id from shipments s
    join forwarders f on f.id = s.forwarder_id
    where f.owner_id = auth.uid()
  ));
