UPDATE public.orders
SET tracking_url = 'https://merchant.carrybee.com/order-track/' || tracking_number
WHERE tracking_url IS NULL
  AND tracking_number ~ '^F[0-9]{4}[A-Z0-9]+$';