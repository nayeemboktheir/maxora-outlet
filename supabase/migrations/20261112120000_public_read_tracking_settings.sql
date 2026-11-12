-- Storefront visitors (anon) must be able to read tracking IDs so GTM / GA4 / TikTok Pixel
-- can load. Previously only FB Pixel keys were publicly readable, so these silently returned no rows.
DROP POLICY IF EXISTS "Public can read tracking settings" ON public.admin_settings;

CREATE POLICY "Public can read tracking settings"
ON public.admin_settings
FOR SELECT
TO public
USING (key = ANY (ARRAY[
  'gtm_id',
  'gtm_enabled',
  'ga_measurement_id',
  'ga_enabled',
  'tiktok_pixel_id',
  'tiktok_pixel_enabled'
]));
