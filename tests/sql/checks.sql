-- Vérifications fonctionnelles, exécutées après schema.sql, seed-exemple.sql et migration-backoffice.sql
\set ON_ERROR_STOP 1
\set QUIET 1

-- 1. Insertion d'un colis : génération du code et événement automatique
insert into shipments (forwarder_id, client_name, client_phone, description)
select id, 'Client SQL', '24100000001', 'Test SQL' from forwarders where slug = 'transit-demo'
returning id as ship_id, tracking_code as code \gset
select set_config('t.ship_id', :'ship_id', false), set_config('t.code', :'code', false) \g /dev/null

do $$
declare
  c text := current_setting('t.code');
  n int;
begin
  assert c ~ '^GC-[0-9A-F]{8}$', 'format du tracking_code invalide : ' || c;
  select count(*) into n from shipment_events e join shipments s on s.id = e.shipment_id
   where s.tracking_code = c and e.status = 'enregistre';
  assert n = 1, 'événement initial attendu : 1, obtenu ' || n;
end;
$$;
\echo ok - insertion colis, tracking_code et événement initial

-- 2. Changement de statut : nouvel événement, updated_at mis à jour
update shipments set status = 'recu_entrepot' where id = :'ship_id';
do $$
begin
  assert (select count(*) from shipment_events where shipment_id = current_setting('t.ship_id')::uuid) = 2, 'événement de changement de statut absent';
end;
$$;
\echo ok - trigger sur changement de statut

-- 3. track_shipment en anonyme : pas de client_phone, code insensible à la casse
set role anon;
select track_shipment(lower(:'code'))::text as tracked \gset
select set_config('t.tracked', :'tracked', false) \g /dev/null
select track_shipment('GC-INCONNU') is null as unknown_null \gset
select set_config('t.unknown_null', :'unknown_null', false) \g /dev/null
reset role;

do $$
declare
  j jsonb := current_setting('t.tracked');
begin
  assert j is not null, 'track_shipment renvoie null pour un code existant';
  assert j->>'status' = 'recu_entrepot', 'statut inattendu';
  assert jsonb_array_length(j->'events') = 2, 'historique incomplet';
  assert j->'events'->0->>'status' = 'recu_entrepot', 'historique non trié du plus récent au plus ancien';
  assert position('client_phone' in j::text) = 0, 'client_phone exposé';
  assert position('24100000001' in j::text) = 0, 'numéro du client exposé';
  assert position('wa_token' in j::text) = 0, 'wa_token exposé';
  assert current_setting('t.unknown_null')::boolean, 'un code inconnu doit renvoyer null';
end;
$$;
\echo ok - track_shipment sans client_phone, code inconnu = null

-- 4. get_chat_context : service_role uniquement
set role service_role;
select get_chat_context('[PHONE_NUMBER_ID_META]', '24100000002')::text as ctx \gset
select set_config('t.ctx', :'ctx', false) \g /dev/null
reset role;

do $$
declare
  j jsonb := current_setting('t.ctx');
begin
  assert j->'tenant'->>'business_name' = 'Salon Belle Allure', 'tenant du seed introuvable';
  assert j->'history' = '[]'::jsonb, 'historique attendu vide';
end;
$$;

insert into messages (tenant_id, wa_id, role, content)
select id, '24100000002', r, 'msg ' || g
from tenants, generate_series(1, 12) g, lateral (select case when g % 2 = 1 then 'user' else 'assistant' end r) x
where phone_number_id = '[PHONE_NUMBER_ID_META]';

set role service_role;
select get_chat_context('[PHONE_NUMBER_ID_META]', '24100000002')::text as ctx2 \gset
select set_config('t.ctx2', :'ctx2', false) \g /dev/null
select get_chat_context('inconnu', '24100000002')::text as ctx3 \gset
select set_config('t.ctx3', :'ctx3', false) \g /dev/null
reset role;

do $$
declare
  j jsonb := current_setting('t.ctx2');
begin
  assert jsonb_array_length(j->'history') = 10, 'historique limité à 10 messages';
  assert j->'history'->0->>'content' = 'msg 3', 'historique non chronologique';
  assert j->'history'->9->>'content' = 'msg 12', 'dernier message absent';
  assert (current_setting('t.ctx3')::jsonb)->'tenant' = 'null'::jsonb, 'tenant inconnu attendu null';
end;
$$;

set role anon;
do $$
begin
  perform get_chat_context('[PHONE_NUMBER_ID_META]', 'x');
  raise exception 'anon ne doit pas pouvoir appeler get_chat_context';
exception when insufficient_privilege then null;
end;
$$;
do $$
begin
  perform get_shipment_notification(gen_random_uuid());
  raise exception 'anon ne doit pas pouvoir appeler get_shipment_notification';
exception when insufficient_privilege then null;
end;
$$;
reset role;
\echo ok - get_chat_context avec un tenant du seed, refusé en anonyme

-- 5. Back-office : transitaire connecté (RLS + set_shipment_status)
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'transit@exemple.test'),
  ('22222222-2222-2222-2222-222222222222', 'autre@exemple.test');
update forwarders set owner_id = '11111111-1111-1111-1111-111111111111' where slug = 'transit-demo';
select id as fw_id from forwarders where slug = 'transit-demo' \gset
select set_config('t.fw_id', :'fw_id', false) \g /dev/null

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false) is not null as _ \gset

select count(*) as own_count from shipments \gset
select set_config('t.own_count', :'own_count', false) \g /dev/null
insert into shipments (forwarder_id, client_name, client_phone)
values (:'fw_id', 'Client Admin', '24100000003')
returning id as admin_ship, tracking_code as admin_code \gset
select set_config('t.admin_ship', :'admin_ship', false), set_config('t.admin_code', :'admin_code', false) \g /dev/null
select set_shipment_status(:'admin_ship', 'groupage', 'Guangzhou', 'Conteneur en préparation') \g /dev/null
select set_shipment_status(:'admin_ship', 'groupage', null, 'Note complémentaire') \g /dev/null
select count(*) as admin_events from shipment_events where shipment_id = :'admin_ship' \gset
select set_config('t.admin_events', :'admin_events', false) \g /dev/null

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false) is not null as _ \gset
select count(*) as other_count from shipments \gset
select set_config('t.other_count', :'other_count', false) \g /dev/null
do $$
begin
  perform set_shipment_status(current_setting('t.admin_ship')::uuid, 'livre');
  raise exception 'un autre compte ne doit pas modifier ce colis';
exception when raise_exception then
  if sqlerrm <> 'colis introuvable' then raise; end if;
end;
$$;
reset role;

do $$
declare
  ev shipment_events;
begin
  assert current_setting('t.own_count')::int = 2, 'le transitaire doit voir ses 2 colis';
  assert current_setting('t.other_count')::int = 0, 'un autre compte ne doit voir aucun colis';
  assert current_setting('t.admin_events')::int = 3, 'événements attendus : 3, obtenus ' || current_setting('t.admin_events');
  select * into ev from shipment_events
   where shipment_id = current_setting('t.admin_ship')::uuid and status = 'groupage' and location = 'Guangzhou';
  assert found and ev.note = 'Conteneur en préparation', 'lieu et note non enregistrés sur l''événement';
  assert (select status from shipments where id = current_setting('t.admin_ship')::uuid) = 'groupage', 'statut non appliqué';
end;
$$;
\echo ok - back-office : RLS, création de colis et set_shipment_status
