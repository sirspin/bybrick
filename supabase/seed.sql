-- SAMPLE DATA for local development and Stripe test mode only. Never load into production.
-- Birdy's details and item prices below are placeholders until the owners supply real ones.
-- stripe_account_id and owner_user_id stay null: the owner claims the business at first
-- sign-in, and Stripe onboarding sets the account id from server code.

insert into public.businesses
  (slug, name, legal_name, owner_display, owner_line, tagline, story, neighborhood, city,
   status_line, contact_email, accent_color)
values
  ('birdys', 'BIRDY''S', 'Birdy''s LLC (SAMPLE: confirm legal name)', 'Carly & Spencer',
   'SAMPLE: a short line about the owners.',
   'Picnic + Pantry',
   'SAMPLE STORY: replace with the owners'' own words.',
   'Irving Park', 'Chicago', 'Opening spring 2027',
   'hello@example.invalid', '#B4452B')
on conflict (slug) do nothing;

insert into public.items
  (business_id, name, short_name, note, price_cents, shipping_cents, tax_cents, install_cents,
   deadline, status, position)
select b.id, v.name, v.short_name, v.note, v.price, v.ship, v.tax, v.install,
       now() + interval '60 days', 'open', v.pos
from public.businesses b
cross join (values
  ('Reach-in cooler (SAMPLE)', 'Cooler', 'SAMPLE: holds the dairy and cold drinks.', 320000, 15000, 29000, 20000, 1),
  ('Wall shelving (SAMPLE)',   'Shelving', 'SAMPLE: the pantry wall.',               84000,  6000,  8000, 12000, 2),
  ('Front counter (SAMPLE)',   'Counter', 'SAMPLE: where you order.',                 180000, 20000, 16500, 0,     3)
) as v(name, short_name, note, price, ship, tax, install, pos)
where b.slug = 'birdys'
  and not exists (select 1 from public.items i where i.business_id = b.id);
