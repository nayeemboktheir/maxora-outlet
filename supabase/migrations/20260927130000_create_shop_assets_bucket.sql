-- Create the `shop-assets` storage bucket used by every uploader in the admin UI
-- (product images, banners, shop logo/favicon, landing-page builder).
-- The bucket was referenced in application code but never provisioned, so all
-- uploads failed with NoSuchBucket.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'shop-assets',
  'shop-assets',
  true,
  5242880, -- 5MB, matches the client-side validation
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
    'image/x-icon',
    'image/vnd.microsoft.icon'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Assets are served publicly via getPublicUrl(), so anyone may read them.
DROP POLICY IF EXISTS "Public can read shop assets" ON storage.objects;
CREATE POLICY "Public can read shop assets"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'shop-assets');

-- Only admins may add, change or remove assets.
DROP POLICY IF EXISTS "Admins can upload shop assets" ON storage.objects;
CREATE POLICY "Admins can upload shop assets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'shop-assets'
    AND (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
  );

DROP POLICY IF EXISTS "Admins can update shop assets" ON storage.objects;
CREATE POLICY "Admins can update shop assets"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'shop-assets'
    AND (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
  )
  WITH CHECK (
    bucket_id = 'shop-assets'
    AND (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
  );

DROP POLICY IF EXISTS "Admins can delete shop assets" ON storage.objects;
CREATE POLICY "Admins can delete shop assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'shop-assets'
    AND (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))
  );
