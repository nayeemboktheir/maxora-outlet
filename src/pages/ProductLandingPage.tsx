import { useState, useEffect, useCallback, memo, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";import {
  Truck,
  Phone,
  CheckCircle2,
  ShoppingBag,
  MessageCircle,
  MapPin,
  Plus,
  Trash2,
} from "lucide-react";

import {
  ShippingMethodSelector,
  ShippingZone,
  SHIPPING_RATES,
} from "@/components/checkout/ShippingMethodSelector";
import { toast } from "sonner";
import { resolveVariantPricing } from "@/lib/pricing";
import type { ProductSizeOption } from "@/types";
import { resolveLandingSettings } from "@/lib/productLanding";
import {
  OptimizedImage,
  UrgencyBanner,
  HeroSection,
  FeaturesBanner,
  GallerySection,
  VideoSection,
  ProductDescriptionSection,
  DeliverySection,
} from "@/components/product-landing/Sections";

// ====== Interfaces ======
interface ProductVariation {
  id: string;
  name: string;
  price: number;
  original_price?: number;
  stock: number;
  image_url?: string | null;
}

interface ProductData {
  id: string;
  name: string;
  price: number;
  original_price?: number;
  images: string[];
  video_url?: string;
  description?: string;
  short_description?: string;
  long_description?: string;
  landing_settings?: unknown;
  variations: ProductVariation[];
  colors?: string[];
  sizes: ProductSizeOption[];
  /** Stock per `${variationId}|${sizeId}`, only used when both axes exist. */
  comboStock: Record<string, number>;
}

interface OrderForm {
  name: string;
  phone: string;
  address: string;
  lines: OrderLine[];
  totalQuantity: number;
  shippingZone?: ShippingZone;
  subtotal?: number;
  shippingCost?: number;
  total?: number;
}

// ====== Size / Colour options ======
interface SizeChoice {
  key: string;
  label: string;
  /** Own price, shown under the label when the size sets one. */
  price?: number;
  sizeId?: string;
  variationId?: string;
}

interface ColorChoice {
  key: string;
  label: string;
  image?: string | null;
  variationId?: string;
}

/** One size/colour combination in the order; same combination = same line. */
interface OrderLine {
  key: string;
  size?: SizeChoice;
  color?: ColorChoice;
  quantity: number;
  unitPrice: number;
}

const lineLabel = (line: OrderLine) =>
  [line.color?.label, line.size?.label].filter(Boolean).join(" / ");

const mergeLine = (lines: OrderLine[], line: OrderLine): OrderLine[] =>
  lines.some((l) => l.key === line.key)
    ? lines.map((l) => (l.key === line.key ? { ...l, quantity: l.quantity + line.quantity } : l))
    : [...lines, line];

/**
 * Products come in two shapes, and the landing page has to read both:
 *
 * - Two-axis products keep sizes in `product_sizes` and colours in
 *   `product_variations` (what Admin → Products edits today).
 * - Older products kept their sizes in `product_variations` and any colours as
 *   plain strings on `products.colors`.
 */
const useProductOptions = (product?: ProductData) => {
  const [sizeKey, setSizeKey] = useState("");
  const [colorKey, setColorKey] = useState("");

  const hasSizeRows = (product?.sizes.length ?? 0) > 0;
  const hasColorVariations = hasSizeRows && (product?.variations.length ?? 0) > 0;

  const { sizes, colors } = useMemo((): { sizes: SizeChoice[]; colors: ColorChoice[] } => {
    if (!product) return { sizes: [], colors: [] };

    const legacyColors: ColorChoice[] = (product.colors || [])
      .filter((c) => typeof c === "string" && c.trim())
      .map((c) => ({ key: `color:${c}`, label: c }));

    if (hasSizeRows) {
      return {
        sizes: product.sizes.map((sz) => ({
          key: sz.id,
          label: sz.name,
          price: sz.price ?? undefined,
          sizeId: sz.id,
        })),
        colors: product.variations.length
          ? product.variations.map((v) => ({
              key: v.id,
              label: v.name,
              image: v.image_url,
              variationId: v.id,
            }))
          : legacyColors,
      };
    }

    const seen = new Set<string>();
    const legacySizes: SizeChoice[] = [];
    for (const v of product.variations) {
      const name = String(v.name || "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      legacySizes.push({ key: v.id, label: name, price: v.price, variationId: v.id });
    }
    return { sizes: legacySizes, colors: legacyColors };
  }, [product, hasSizeRows]);

  const combo = useCallback(
    (variationId?: string, sizeId?: string) =>
      variationId && sizeId ? product?.comboStock[`${variationId}|${sizeId}`] ?? 0 : 0,
    [product]
  );

  const selectedSize = sizes.find((s) => s.key === sizeKey);
  const selectedColor = colors.find((c) => c.key === colorKey);

  // Same availability rules as the product page: with both axes the (colour,
  // size) cell decides; size-only products keep stock on the size row; legacy
  // variation-sizes were never stock-gated here, so they stay open.
  const isSizeSoldOut = useCallback(
    (size: SizeChoice) => {
      if (!product || !size.sizeId) return false;
      if (hasColorVariations) {
        return selectedColor?.variationId
          ? combo(selectedColor.variationId, size.sizeId) <= 0
          : !product.variations.some((v) => combo(v.id, size.sizeId) > 0);
      }
      const row = product.sizes.find((sz) => sz.id === size.sizeId);
      return (row?.stock ?? 0) <= 0;
    },
    [product, hasColorVariations, selectedColor, combo]
  );

  const isColorSoldOut = useCallback(
    (color: ColorChoice) => {
      if (!product || !hasColorVariations || !color.variationId) return false;
      return selectedSize?.sizeId
        ? combo(color.variationId, selectedSize.sizeId) <= 0
        : !product.sizes.some((sz) => combo(color.variationId, sz.id) > 0);
    },
    [product, hasColorVariations, selectedSize, combo]
  );

  const priceFor = useCallback(
    (size?: SizeChoice, color?: ColorChoice) => {
      if (!product) return 0;
      const variationId = color?.variationId ?? size?.variationId;
      return resolveVariantPricing(
        { price: product.price, originalPrice: product.original_price },
        product.variations.find((v) => v.id === variationId),
        product.sizes.find((sz) => sz.id === size?.sizeId)
      ).price;
    },
    [product]
  );

  return {
    sizes,
    colors,
    selectedSize,
    selectedColor,
    selectSize: setSizeKey,
    selectColor: setColorKey,
    isSizeSoldOut,
    isColorSoldOut,
    unitPrice: priceFor(selectedSize, selectedColor),
  };
};

type ProductOptions = ReturnType<typeof useProductOptions>;



// ====== Checkout Form ======
const CheckoutSection = memo(({ product, options, onSubmit, isSubmitting }: {
  product: ProductData; options: ProductOptions; onSubmit: (form: OrderForm) => void; isSubmitting: boolean;
}) => {
  const [form, setForm] = useState({ name: "", phone: "", address: "" });
  const [quantity, setQuantity] = useState(1);
  /** Combinations already added with "আরও যোগ করুন"; the live picker selection rides on top. */
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [shippingZone, setShippingZone] = useState<ShippingZone>('outside_dhaka');
  const formRef = useRef<HTMLFormElement>(null);
  const sizeSelectionRef = useRef<HTMLDivElement>(null);
  const colorSelectionRef = useRef<HTMLElement>(null);
  const {
    sizes, colors, selectedSize, selectedColor, selectSize, selectColor,
    isSizeSoldOut, isColorSoldOut, unitPrice,
  } = options;

  const hasOptions = sizes.length > 0 || colors.length > 0;
  const optionWord = sizes.length > 0 && colors.length > 0 ? 'সাইজ/কালার' : sizes.length > 0 ? 'সাইজ' : 'কালার';

  const selectionComplete =
    (sizes.length === 0 || !!selectedSize) &&
    (colors.length === 0 || !!selectedColor) &&
    !(selectedSize && isSizeSoldOut(selectedSize)) &&
    !(selectedColor && isColorSoldOut(selectedColor));

  const currentLine: OrderLine | null = selectionComplete
    ? {
        key: `${selectedSize?.key ?? ''}|${selectedColor?.key ?? ''}`,
        size: selectedSize,
        color: selectedColor,
        quantity,
        unitPrice,
      }
    : null;

  // A complete selection still in the picker is ordered too, so a single-item
  // order never needs the "add" button.
  const orderLines = currentLine ? mergeLine(lines, currentLine) : lines;
  const totalQuantity = orderLines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = orderLines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const shippingCost = SHIPPING_RATES[shippingZone];
  const total = subtotal + shippingCost;

  /** Explains (and scrolls to) whatever keeps the picker selection from being orderable. */
  const reportSelectionProblem = () => {
    if (sizes.length > 0 && !selectedSize) {
      toast.error("সাইজ সিলেক্ট করুন");
      sizeSelectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (colors.length > 0 && !selectedColor) {
      toast.error("কালার সিলেক্ট করুন");
      colorSelectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      toast.error("এই কম্বিনেশন স্টকে নেই");
    }
  };

  const addCurrentLine = () => {
    if (!currentLine) {
      reportSelectionProblem();
      return;
    }
    setLines(orderLines);
    selectSize("");
    selectColor("");
    setQuantity(1);
    toast.success(`যোগ হয়েছে — এবার আরেকটি ${optionWord} বেছে নিন`);
  };

  const changeLineQuantity = (key: string, delta: number) => {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, l.quantity + delta) } : l))
    );
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (orderLines.length === 0) {
      reportSelectionProblem();
      return;
    }
    if (!form.name.trim() || !form.phone.trim() || !form.address.trim()) {
      toast.error("সব তথ্য পূরণ করুন");
      return;
    }
    if (!/^01[3-9]\d{8}$/.test(form.phone.replace(/\s/g, ''))) {
      toast.error("সঠিক মোবাইল নম্বর দিন");
      return;
    }
    onSubmit({ ...form, lines: orderLines, totalQuantity, shippingZone, subtotal, shippingCost, total });
  };

  const updateForm = useCallback((key: keyof typeof form, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  }, []);

  return (
    <section id="checkout" className="py-8 md:py-12 bg-gradient-to-b from-secondary/40 to-background">
      <div className="container mx-auto px-4">
        <div className="text-center mb-6">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground">অর্ডার করুন</h2>
          <p className="text-muted-foreground text-sm mt-1">পণ্য হাতে পেয়ে মূল্য পরিশোধ করুন</p>
        </div>

        {/* Form on the left, colour panel on the right (above the form on mobile). */}
        <div
          className={`max-w-lg mx-auto ${
            colors.length > 0 ? 'lg:max-w-none lg:grid lg:grid-cols-[32rem_24rem] lg:justify-center lg:items-start lg:gap-6' : ''
          }`}
        >
          {colors.length > 0 && (
            <aside ref={colorSelectionRef} className="mb-4 lg:mb-0 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4">
              <div className="bg-card rounded-xl shadow-lg overflow-hidden border border-border">
                <div className="bg-gradient-to-r from-primary to-accent text-primary-foreground py-3 px-4 font-bold flex items-center gap-2">
                  <span aria-hidden>🎨</span>
                  কালার নির্বাচন করুন <span className="text-primary-foreground/80">*</span>
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-4 gap-3">
                    {colors.map((c) => {
                      const soldOut = isColorSoldOut(c);
                      const active = selectedColor?.key === c.key;
                      return (
                        <button
                          key={c.key}
                          type="button"
                          disabled={soldOut}
                          onClick={() => selectColor(c.key)}
                          aria-pressed={active}
                          title={c.label}
                          className={`group flex flex-col items-center gap-1.5 rounded-lg p-1.5 transition-colors ${
                            active ? 'bg-primary/10' : 'hover:bg-secondary/60'
                          } ${soldOut ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <span className={`relative block rounded-full p-0.5 transition-all ${
                            active ? 'ring-2 ring-primary' : 'ring-1 ring-border group-hover:ring-primary/50'
                          }`}>
                            {c.image ? (
                              <img src={c.image} alt="" loading="lazy" className="w-11 h-11 rounded-full object-cover ring-1 ring-black/10" />
                            ) : (
                              <span className="block w-11 h-11 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 ring-1 ring-black/10" />
                            )}
                            {active && <CheckCircle2 className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-background text-primary" />}
                          </span>
                          <span className={`text-xs leading-tight text-center line-clamp-2 ${
                            active ? 'text-primary font-bold' : 'text-foreground font-medium'
                          } ${soldOut ? 'line-through' : ''}`}>
                            {c.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-3 border-t border-border text-sm text-center">
                    {selectedColor ? (
                      <span className="text-foreground">নির্বাচিত কালার: <span className="font-bold text-primary">{selectedColor.label}</span></span>
                    ) : lines.length > 0 ? (
                      <span className="text-muted-foreground text-xs">আরেকটি কালার নিতে চাইলে সিলেক্ট করুন</span>
                    ) : (
                      <span className="text-destructive text-xs">* কালার সিলেক্ট করুন</span>
                    )}
                  </div>
                </div>
              </div>
            </aside>
          )}

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4 lg:col-start-1 lg:row-start-1">
            {/* Product Card */}
            <div className="bg-card rounded-xl shadow-lg overflow-hidden border border-border">
              <div className="bg-gradient-to-r from-primary to-accent text-primary-foreground py-3 px-4 font-bold flex items-center gap-2">
                <ShoppingBag className="h-4 w-4" />
                প্রোডাক্ট
              </div>
              
              <div className="p-4">
                {/* Product Info Row */}
                <div className="flex gap-3 items-center mb-4">
                  <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                    {product.images?.[0] && <OptimizedImage src={product.images[0]} alt="" className="w-full h-full" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-foreground truncate">{product.name}</p>
                    <p className="text-xl font-bold text-primary">৳{unitPrice.toLocaleString()}</p>
                  </div>
                </div>
                {/* Size Selection */}
                {sizes.length > 0 && (
                  <div ref={sizeSelectionRef} className="mb-4">
                    <p className="text-sm font-medium text-foreground mb-2">সাইজ নির্বাচন করুন <span className="text-destructive">*</span></p>
                    <div className="flex flex-wrap gap-2">
                      {sizes.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          disabled={isSizeSoldOut(s)}
                          onClick={() => selectSize(s.key)}
                          className={`px-4 py-2.5 rounded-lg font-semibold transition-all border-2 disabled:opacity-50 disabled:line-through disabled:cursor-not-allowed ${
                            selectedSize?.key === s.key
                              ? 'border-primary bg-primary text-primary-foreground shadow-md'
                              : 'border-border bg-secondary/50 text-foreground hover:border-primary/50'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    {!selectedSize && lines.length === 0 && (
                      <p className="text-xs text-destructive mt-1">* সাইজ সিলেক্ট করুন</p>
                    )}
                  </div>
                )}

                {/* Quantity */}
                <div className="flex items-center justify-between bg-secondary/50 p-3 rounded-lg">
                  <span className="font-medium text-foreground">পরিমাণ</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      className="w-9 h-9 rounded-full bg-muted flex items-center justify-center hover:bg-muted/70 font-bold text-lg text-foreground"
                    >−</button>
                    <span className="text-lg font-bold w-6 text-center text-foreground">{quantity}</span>
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => q + 1)}
                      className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 font-bold text-lg"
                    >+</button>
                  </div>
                </div>

                {hasOptions && (
                  <button
                    type="button"
                    onClick={addCurrentLine}
                    className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/60 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    আরও {optionWord} যোগ করুন
                  </button>
                )}

                {/* Combinations already added */}
                {lines.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm font-medium text-foreground">যোগ করা পণ্য</p>
                    {lines.map((l) => (
                      <div key={l.key} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-2.5">
                        {l.color?.image && (
                          <img src={l.color.image} alt="" loading="lazy" className="w-9 h-9 rounded-full object-cover ring-1 ring-black/10 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{lineLabel(l)}</p>
                          <p className="text-xs text-muted-foreground">৳{l.unitPrice.toLocaleString()} × {l.quantity}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => changeLineQuantity(l.key, -1)}
                            className="w-7 h-7 rounded-full bg-muted flex items-center justify-center hover:bg-muted/70 font-bold text-foreground"
                          >−</button>
                          <span className="text-sm font-bold w-5 text-center text-foreground">{l.quantity}</span>
                          <button
                            type="button"
                            onClick={() => changeLineQuantity(l.key, 1)}
                            className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 font-bold"
                          >+</button>
                          <button
                            type="button"
                            onClick={() => removeLine(l.key)}
                            aria-label="মুছে ফেলুন"
                            className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Customer Info */}
            <div className="bg-card rounded-xl shadow-lg p-4 border border-border space-y-3">
              <h3 className="font-bold flex items-center gap-2 text-foreground">
                <Phone className="h-4 w-4 text-primary" />
                আপনার তথ্য
              </h3>
              <Input
                value={form.phone}
                onChange={(e) => updateForm('phone', e.target.value)}
                placeholder="মোবাইল নম্বর *"
                type="tel"
                inputMode="numeric"
                required
                className="h-12 text-base rounded-lg border-2 focus:border-primary"
              />
              <Input
                value={form.name}
                onChange={(e) => updateForm('name', e.target.value)}
                placeholder="আপনার নাম *"
                required
                className="h-12 text-base rounded-lg border-2 focus:border-primary"
              />
              <div className="relative">
                <MapPin className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
                <Textarea
                  value={form.address}
                  onChange={(e) => updateForm('address', e.target.value)}
                  placeholder="সম্পূর্ণ ঠিকানা (বাড়ি, রোড, থানা, জেলা) *"
                  required
                  rows={2}
                  className="pl-10 text-base rounded-lg border-2 focus:border-primary resize-none"
                />
              </div>
            </div>

            {/* Shipping */}
            <div className="bg-card rounded-xl shadow-lg p-4 border border-border">
              <h3 className="font-bold flex items-center gap-2 text-foreground mb-3">
                <Truck className="h-4 w-4 text-accent" />
                ডেলিভারি এরিয়া
              </h3>
              <ShippingMethodSelector
                address={form.address}
                selectedZone={shippingZone}
                onZoneChange={setShippingZone}
              />
            </div>

            {/* Order Summary */}
            <div className="gradient-dark rounded-xl p-4 text-white">
              <div className="space-y-2 text-sm">
                {hasOptions && orderLines.length > 0 && (
                  <div className="space-y-1 pb-2 border-b border-white/20">
                    {orderLines.map((l) => (
                      <div key={l.key} className="flex justify-between gap-3 text-white/80">
                        <span className="truncate">{lineLabel(l)} × {l.quantity}</span>
                        <span>৳{(l.unitPrice * l.quantity).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-white/60">সাবটোটাল ({totalQuantity}টি)</span>
                  <span>৳{subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/60">ডেলিভারি</span>
                  <span>৳{shippingCost}</span>
                </div>
                <div className="flex justify-between text-lg font-bold pt-2 border-t border-white/20">
                  <span>সর্বমোট</span>
                  <span className="text-accent">৳{total.toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-14 text-lg font-bold bg-gradient-to-r from-accent to-primary hover:from-primary hover:to-accent text-primary-foreground rounded-xl shadow-xl disabled:opacity-70"
            >
              {isSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  প্রসেসিং...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5" />
                  অর্ডার কনফার্ম করুন — ৳{total.toLocaleString()}
                </span>
              )}
            </Button>

            {/* Contact */}
            <div className="text-center text-sm text-muted-foreground space-y-1">
              <p>
                কল করুন: <a href="tel:+8801719725181" className="font-bold text-foreground">01719725181</a>
              </p>
              <a 
                href="https://wa.me/8801719725181"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent font-medium"
              >
                <MessageCircle className="h-4 w-4" />
                WhatsApp
              </a>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
});
CheckoutSection.displayName = 'CheckoutSection';

// ====== Main Component ======
const ProductLandingPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [currentImage, setCurrentImage] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showFloatingCta, setShowFloatingCta] = useState(true);
  const checkoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkVisibility = () => {
      if (checkoutRef.current) {
        const rect = checkoutRef.current.getBoundingClientRect();
        const isCheckoutVisible = rect.top < window.innerHeight * 0.7;
        setShowFloatingCta(!isCheckoutVisible);
      }
    };

    window.addEventListener('scroll', checkVisibility, { passive: true });
    const timer = setTimeout(checkVisibility, 100);

    return () => {
      window.removeEventListener('scroll', checkVisibility);
      clearTimeout(timer);
    };
  }, []);

  const { data: product, isLoading, error } = useQuery({
    queryKey: ["product-landing", slug],
    queryFn: async () => {
      const { data: landingPage } = await supabase
        .from("landing_pages")
        .select("*")
        .eq("slug", slug)
        .eq("is_published", true)
        .single();

      const productId = landingPage?.product_ids?.[0];

      const loadOptions = async (id: string) => {
        const [{ data: variations }, { data: sizes }] = await Promise.all([
          supabase
            .from("product_variations")
            .select("*")
            .eq("product_id", id)
            .eq("is_active", true)
            .order("sort_order"),
          supabase
            .from("product_sizes")
            .select("id, name, price, original_price, image_url, stock, sort_order")
            .eq("product_id", id)
            .eq("is_active", true)
            .order("sort_order"),
        ]);

        const comboStock: Record<string, number> = {};
        if (sizes?.length) {
          const { data: stockRows } = await supabase
            .from("product_variation_stock")
            .select("variation_id, size_id, stock")
            .in("size_id", sizes.map((sz) => sz.id));
          for (const row of stockRows || []) {
            comboStock[`${row.variation_id}|${row.size_id}`] = row.stock ?? 0;
          }
        }

        return { variations: variations || [], sizes: sizes || [], comboStock };
      };

      if (productId) {
        const { data: productData } = await supabase.from("products").select("*, long_description").eq("id", productId).single();
        if (productData) {
          return { ...productData, images: productData.images || [], ...(await loadOptions(productId)) } as ProductData;
        }
      }

      const { data: directProduct } = await supabase.from("products").select("*, long_description").eq("slug", slug).single();
      if (directProduct) {
        return { ...directProduct, images: directProduct.images || [], ...(await loadOptions(directProduct.id)) } as ProductData;
      }

      throw new Error("Product not found");
    },
    staleTime: 5 * 60 * 1000,
  });

  const options = useProductOptions(product);
  const landing = useMemo(() => resolveLandingSettings(product?.landing_settings), [product?.landing_settings]);

  const scrollToCheckout = useCallback(() => {
    document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const handleOrderSubmit = async (form: OrderForm) => {
    if (!product) return;
    setIsSubmitting(true);

    try {
      const { data, error } = await supabase.functions.invoke('place-order', {
        body: {
          userId: null,
          items: form.lines.map((l) => ({
            productId: product.id,
            variationId: l.color?.variationId ?? l.size?.variationId ?? null,
            sizeId: l.size?.sizeId || null,
            size: l.size?.sizeId ? l.size.label : null,
            // A colour backed by a variation is already recorded via variationId.
            color: l.color && !l.color.variationId ? l.color.label : null,
            quantity: l.quantity,
          })),
          shipping: { name: form.name, phone: form.phone, address: form.address },
          shippingZone: form.shippingZone,
          orderSource: 'landing_page',
          notes: `LP:${slug}`,
        },
      });

      if (error) throw error;

      if (data?.error) {
        toast.error(data.error);
        return;
      }

      if (!data?.orderId) {
        throw new Error('Order was not created');
      }

      navigate('/order-confirmation', {
        state: {
          orderNumber: data.orderNumber || data.orderId,
          customerName: form.name,
          phone: form.phone,
          total: form.total,
          items: form.lines.map((l) => ({
            productId: product.id,
            productName: lineLabel(l) ? `${product.name} (${lineLabel(l)})` : product.name,
            price: l.unitPrice,
            quantity: l.quantity,
          })),
          numItems: form.totalQuantity,
          fromLandingPage: true,
          landingPageSlug: slug,
        }
      });
    } catch (err) {
      console.error("Order error:", err);
      toast.error("অর্ডার করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
        <h1 className="text-xl font-bold mb-4 text-foreground">প্রোডাক্ট পাওয়া যায়নি</h1>
        <Button onClick={() => navigate("/")} className="bg-primary hover:bg-primary/90 text-primary-foreground">হোম পেজে যান</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {landing.sections.urgency && <UrgencyBanner content={landing.urgency} />}
      <HeroSection product={product} content={landing.hero} currentImage={currentImage} setCurrentImage={setCurrentImage} onBuyNow={scrollToCheckout} />
      {landing.sections.features && <FeaturesBanner features={landing.features} />}
      {landing.sections.description && <ProductDescriptionSection description={product.long_description} content={landing.description} />}
      {landing.sections.gallery && <GallerySection images={product.images} content={landing.gallery} />}
      {landing.sections.video && <VideoSection videoUrl={product.video_url} content={landing.video} />}
      {landing.sections.delivery && <DeliverySection content={landing.delivery} />}
      <div ref={checkoutRef}>
        <CheckoutSection product={product} options={options} onSubmit={handleOrderSubmit} isSubmitting={isSubmitting} />
      </div>
      
      {/* Floating CTA */}
      {showFloatingCta && (
        <div className="fixed bottom-0 left-0 right-0 p-3 bg-background/95 backdrop-blur-sm border-t border-border md:hidden z-50 safe-area-inset-bottom">
          <Button
            onClick={scrollToCheckout}
            className="w-full h-12 text-base font-bold bg-gradient-to-r from-primary to-accent text-primary-foreground rounded-xl shadow-lg"
          >
            <ShoppingBag className="mr-2 h-5 w-5" />
            {landing.floatingCtaText}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ProductLandingPage;
