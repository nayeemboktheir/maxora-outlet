-- Per-product content for the /step/[slug] landing page.
--
-- The product landing page used to hard-code its banner, CTA, features, section
-- headings and delivery text. Admin → Landing Pages → Product Landing Pages now
-- edits those per product, stored here as a partial override object: any key
-- that is missing or blank falls back to the built-in default text, so the
-- empty object keeps every existing page exactly as it was.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS landing_settings jsonb DEFAULT '{}'::jsonb NOT NULL;
