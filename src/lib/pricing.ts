import { CartItem, Product, ProductSizeOption, ProductVariation } from '@/types';

/**
 * Both option axes (colour and size) may carry their own price, so a single
 * rule decides which one a customer pays. Most specific wins:
 *
 *   1. the chosen size's price, when it has one
 *   2. the chosen colour variation's price
 *   3. the product's base price
 *
 * Sizes beat colours because a shop that prices by size (a three-piece sold at
 * one price per size across every colour) is the case this axis was added for;
 * a size left blank inherits, which is what label-only sizes have always done.
 *
 * `original_price` (the struck-through "was" price) follows the same ladder but
 * is resolved independently, so a size can introduce a discount on a colour
 * that had none.
 */
export interface VariantPricing {
  price: number;
  originalPrice?: number;
}

const positive = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

export const resolveVariantPricing = (
  product: Pick<Product, 'price' | 'originalPrice'>,
  variation?: Pick<ProductVariation, 'price' | 'original_price'> | null,
  sizeOption?: Pick<ProductSizeOption, 'price' | 'original_price'> | null
): VariantPricing => {
  const price =
    positive(sizeOption?.price) ?? positive(variation?.price) ?? product.price;

  const originalPrice =
    positive(sizeOption?.original_price) ??
    positive(variation?.original_price) ??
    positive(product.originalPrice);

  // An "old price" at or below the live price is not a discount; hide it rather
  // than rendering a strike-through that reads as a price increase.
  return {
    price,
    originalPrice: originalPrice && originalPrice > price ? originalPrice : undefined,
  };
};

/** Convenience wrapper for the shape the cart stores. */
export const resolveCartItemPricing = (item: CartItem): VariantPricing =>
  resolveVariantPricing(item.product, item.variation, item.sizeOption);

export const cartItemUnitPrice = (item: CartItem): number =>
  resolveCartItemPricing(item).price;
