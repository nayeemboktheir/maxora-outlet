# Image-based color options for landing-page orders

## What will change
- Replace the confusing comma-separated Colors field and “Size Variations” wording with one clear **Color / Product Options** section.
- Let the admin add any number of options; each row will include its own image, color/option name, selling price, previous price, and stock.
- Start new option lists empty instead of automatically adding Size 36/38/40.
- Keep these options connected to the products selected in a landing page’s Checkout section.
- Show every saved color as a separate image card in the landing-page checkout, with checkbox and quantity controls so customers can select multiple colors in one order.
- Use the product image only when an option-specific image was not uploaded.

## Order behavior
- Each checked color will be submitted as a separate order item with its own quantity, price, stock reference, and option name.
- Products without color options will remain orderable as one normal product card.

## Technical details
- Reuse the existing product variation records and image field; no database change is needed.
- Remove the duplicate text-only color input from the product form to prevent conflicting color systems.
- Preserve existing size or other variation records: they will continue to work as generic product options.
- Verify creating/editing a product option and selecting multiple colors in the landing-page checkout.
