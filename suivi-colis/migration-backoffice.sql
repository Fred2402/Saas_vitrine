-- Migration pour le back-office (à exécuter après schema.sql)

-- Changement de statut par le transitaire connecté, avec lieu et note
create or replace function set_shipment_status(
  p_shipment_id uuid,
  p_status text,
  p_location text default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s shipments;
begin
  select sh.* into s
  from shipments sh
  join forwarders f on f.id = sh.forwarder_id
  where sh.id = p_shipment_id and f.owner_id = auth.uid();

  if not found then
    raise exception 'colis introuvable';
  end if;

  if p_status is distinct from s.status then
    update shipments set status = p_status where id = p_shipment_id;
    update shipment_events
       set location = p_location, note = p_note
     where id = (
       select id from shipment_events
       where shipment_id = p_shipment_id
       order by created_at desc, id
       limit 1
     );
  else
    insert into shipment_events (shipment_id, status, location, note)
    values (p_shipment_id, p_status, p_location, p_note);
  end if;
end;
$$;

revoke all on function set_shipment_status(uuid, text, text, text) from public, anon;
grant execute on function set_shipment_status(uuid, text, text, text) to authenticated;

-- Rattacher un compte transitaire à son entreprise (remplacer les valeurs) :
-- update forwarders set owner_id = (select id from auth.users where email = '[EMAIL_DU_TRANSITAIRE]') where slug = '[SLUG]';
