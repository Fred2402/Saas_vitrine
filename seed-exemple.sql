-- Données de test (à exécuter après schema.sql). Remplacer les valeurs entre crochets.

insert into tenants (business_name, phone_number_id, system_prompt, knowledge_base, owner_phone)
values (
  'Salon Belle Allure',
  '[PHONE_NUMBER_ID_META]',
  'Ton chaleureux et professionnel. Tu aides à prendre rendez-vous et à renseigner sur les prestations.',
  'Horaires : du mardi au samedi, 9h à 18h. Fermé dimanche et lundi.' || E'\n' ||
  'Adresse : [adresse du salon].' || E'\n' ||
  'Prestations : coupe, brushing, coloration, tresses, soins. Les tarifs sont communiqués par l''équipe sur demande.' || E'\n' ||
  'Rendez-vous : confirmés par l''équipe après la demande du client.',
  '[NUMERO_PROPRIETAIRE]'
);

insert into forwarders (name, slug, phone_number_id, contact_phone)
values ('Transit Demo', 'transit-demo', '[PHONE_NUMBER_ID_META]', '[NUMERO_CONTACT]');

insert into shipments (forwarder_id, client_name, client_phone, description, weight_kg, container_ref, eta, status)
select id, 'Client Test', '[NUMERO_CLIENT_FORMAT_INTERNATIONAL]', 'Carton vêtements, 2 pièces', 18.5, 'MSKU0000000', current_date + 35, 'enregistre'
from forwarders where slug = 'transit-demo';

insert into prospects (company, contact_name, email, website, sector, city, country, offer)
values ('Salon Exemple', 'Madame Exemple', 'contact@exemple.fr', 'https://exemple.fr', 'coiffure', 'Lyon', 'FR', 'chatbot');
