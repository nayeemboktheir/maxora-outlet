import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { CartItem, Product, ProductVariation } from '@/types';

interface CartState {
  items: CartItem[];
  isOpen: boolean;
}

const loadCartFromStorage = (): CartItem[] => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('cart');
    return saved ? JSON.parse(saved) : [];
  }
  return [];
};

const saveCartToStorage = (items: CartItem[]) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem('cart', JSON.stringify(items));
  }
};

// Generate a unique key for cart items based on product id and variation id
const getCartItemKey = (productId: string, variationId?: string, color?: string): string => {
  return `${productId}|${variationId || ''}|${color || ''}`;
};

const initialState: CartState = {
  items: loadCartFromStorage(),
  isOpen: false,
};

const cartSlice = createSlice({
  name: 'cart',
  initialState,
  reducers: {
    addToCart: (
      state,
      action: PayloadAction<{ product: Product; quantity?: number; variation?: ProductVariation; color?: string }>
    ) => {
      const { product, quantity = 1, variation, color } = action.payload;
      const itemKey = getCartItemKey(product.id, variation?.id, color);

      const existingItem = state.items.find(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) === itemKey
      );

      if (existingItem) {
        existingItem.quantity += quantity;
      } else {
        state.items.push({ product, quantity, variation, color });
      }
      saveCartToStorage(state.items);
    },
    removeFromCart: (state, action: PayloadAction<{ productId: string; variationId?: string; color?: string }>) => {
      const { productId, variationId, color } = action.payload;
      const itemKey = getCartItemKey(productId, variationId, color);

      state.items = state.items.filter(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) !== itemKey
      );
      saveCartToStorage(state.items);
    },
    updateQuantity: (
      state,
      action: PayloadAction<{ productId: string; variationId?: string; color?: string; quantity: number }>
    ) => {
      const { productId, variationId, color, quantity } = action.payload;
      const itemKey = getCartItemKey(productId, variationId, color);

      const item = state.items.find(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) === itemKey
      );
      if (item) {
        item.quantity = Math.max(1, quantity);
      }
      saveCartToStorage(state.items);
    },
    setCartItemVariation: (
      state,
      action: PayloadAction<{ productId: string; fromVariationId?: string; color?: string; variation?: ProductVariation }>
    ) => {
      const { productId, fromVariationId, color, variation } = action.payload;

      const fromKey = getCartItemKey(productId, fromVariationId, color);
      const existing = state.items.find(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) === fromKey
      );
      if (!existing) return;

      // Remove the old item
      state.items = state.items.filter(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) !== fromKey
      );

      // Add/merge into the target item key
      const toKey = getCartItemKey(productId, variation?.id, color);
      const target = state.items.find(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) === toKey
      );

      if (target) {
        target.quantity += existing.quantity;
      } else {
        state.items.push({ ...existing, variation });
      }

      saveCartToStorage(state.items);
    },
    setCartItemColor: (
      state,
      action: PayloadAction<{ productId: string; variationId?: string; fromColor?: string; color?: string }>
    ) => {
      const { productId, variationId, fromColor, color } = action.payload;
      const fromKey = getCartItemKey(productId, variationId, fromColor);
      const existing = state.items.find(
        (item) => getCartItemKey(item.product.id, item.variation?.id, item.color) === fromKey
      );
      if (!existing) return;
      existing.color = color;
      saveCartToStorage(state.items);
    },
    clearCart: (state) => {
      state.items = [];
      saveCartToStorage(state.items);
    },
    toggleCart: (state) => {
      state.isOpen = !state.isOpen;
    },
    openCart: (state) => {
      state.isOpen = true;
    },
    closeCart: (state) => {
      state.isOpen = false;
    },
  },
});

export const {
  addToCart,
  removeFromCart,
  updateQuantity,
  setCartItemVariation,
  setCartItemColor,
  clearCart,
  toggleCart,
  openCart,
  closeCart,
} = cartSlice.actions;

export const selectCartItems = (state: { cart: CartState }) => state.cart.items;
export const selectCartTotal = (state: { cart: CartState }) =>
  state.cart.items.reduce((total, item) => {
    const price = item.variation?.price ?? item.product.price;
    return total + price * item.quantity;
  }, 0);
export const selectCartCount = (state: { cart: CartState }) =>
  state.cart.items.reduce((count, item) => count + item.quantity, 0);
export const selectIsCartOpen = (state: { cart: CartState }) => state.cart.isOpen;

export default cartSlice.reducer;
