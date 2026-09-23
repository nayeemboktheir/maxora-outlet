-- Run on the target after import. Expected source snapshot: 22 products,
-- 127 variations, 1,229 orders, 1,259 order_items, 106 draft_orders,
-- 2 auth users, 160 Storage objects (before final cutover export).
SELECT 'products' AS name, count(*) AS rows FROM public.products
UNION ALL SELECT 'product_variations', count(*) FROM public.product_variations
UNION ALL SELECT 'orders', count(*) FROM public.orders
UNION ALL SELECT 'order_items', count(*) FROM public.order_items
UNION ALL SELECT 'draft_orders', count(*) FROM public.draft_orders
UNION ALL SELECT 'auth.users', count(*) FROM auth.users
UNION ALL SELECT 'storage.objects', count(*) FROM storage.objects
UNION ALL SELECT 'public RLS policies', count(*) FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'public functions', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
ORDER BY name;

SELECT tablename FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
WHERE t.schemaname = 'public' AND NOT c.relrowsecurity;
