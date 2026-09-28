/**
 * Editable content for the product landing page (/step/[slug]).
 *
 * `products.landing_settings` stores a partial override object. Anything
 * missing or blank falls back to DEFAULT_PRODUCT_LANDING, so a product that was
 * never edited renders exactly the built-in page.
 */

export const LANDING_SECTION_KEYS = [
  "urgency",
  "features",
  "description",
  "gallery",
  "video",
  "delivery",
] as const;

export type LandingSectionKey = (typeof LANDING_SECTION_KEYS)[number];

export interface LandingFeature {
  icon: string;
  text: string;
}

export interface LandingDeliveryItem {
  title: string;
  sub: string;
}

export interface ProductLandingSettings {
  sections: Record<LandingSectionKey, boolean>;
  /** `{n}` is replaced by the number; wrap text in `**` to make it bold. */
  urgency: { viewersText: string; stockText: string };
  hero: { badge: string; ctaText: string; trustBadges: string[] };
  features: LandingFeature[];
  description: { badge: string; heading: string; cardTitle: string; footerText: string };
  gallery: { badge: string; heading: string };
  video: { badge: string; heading: string };
  delivery: { heading: string; items: LandingDeliveryItem[] };
  floatingCtaText: string;
}

export type ProductLandingOverrides = {
  sections?: Partial<Record<LandingSectionKey, boolean>>;
  urgency?: Partial<ProductLandingSettings["urgency"]>;
  hero?: Partial<ProductLandingSettings["hero"]>;
  features?: LandingFeature[];
  description?: Partial<ProductLandingSettings["description"]>;
  gallery?: Partial<ProductLandingSettings["gallery"]>;
  video?: Partial<ProductLandingSettings["video"]>;
  delivery?: { heading?: string; items?: Partial<LandingDeliveryItem>[] };
  floatingCtaText?: string;
};

export const LANDING_SECTION_LABELS: Record<LandingSectionKey, string> = {
  urgency: "Urgency banner",
  features: "Features strip",
  description: "Product description",
  gallery: "Gallery",
  video: "Video",
  delivery: "Delivery & payment",
};

export const DEFAULT_PRODUCT_LANDING: ProductLandingSettings = {
  sections: {
    urgency: true,
    features: true,
    description: true,
    gallery: true,
    video: true,
    delivery: true,
  },
  urgency: {
    viewersText: "**{n} জন** এখন দেখছেন",
    stockText: "মাত্র **{n}টি** স্টকে আছে!",
  },
  hero: {
    badge: "🔥 হট সেলিং প্রোডাক্ট",
    ctaText: "এখনই অর্ডার করুন",
    trustBadges: ["১০০% গ্যারান্টি", "সারাদেশে ডেলিভারি", "ক্যাশ অন ডেলিভারি"],
  },
  features: [
    { text: "প্রিমিয়াম কোয়ালিটি", icon: "✨" },
    { text: "কালার গ্যারান্টি", icon: "🎨" },
    { text: "কমফোর্টেবল ফিট", icon: "👕" },
    { text: "ইজি এক্সচেঞ্জ", icon: "🔄" },
  ],
  description: {
    badge: "📋 বিস্তারিত",
    heading: "প্রোডাক্ট বিবরণ",
    cardTitle: "এই প্রোডাক্টের বৈশিষ্ট্য",
    footerText: "১০০% কোয়ালিটি গ্যারান্টি সহ",
  },
  gallery: { badge: "📸 গ্যালারি", heading: "প্রোডাক্ট গ্যালারি" },
  video: { badge: "ভিডিও দেখুন", heading: "প্রোডাক্ট ভিডিও" },
  delivery: {
    heading: "ডেলিভারি ও পেমেন্ট",
    items: [
      { title: "ঢাকায় ৮০৳", sub: "বাইরে ১৩০৳" },
      { title: "১-৩ দিনে", sub: "ডেলিভারি" },
      { title: "ক্যাশ অন", sub: "ডেলিভারি" },
    ],
  },
  floatingCtaText: "এখনই অর্ডার করুন",
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

const texts = <T extends { [K in keyof T]: string }>(raw: unknown, defaults: T): T => {
  const src = isObject(raw) ? raw : {};
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    out[key] = text(src[key], defaults[key]) as T[typeof key];
  }
  return out;
};

/** Merge stored overrides over the defaults. Blank strings mean "use default". */
export const resolveLandingSettings = (raw: unknown): ProductLandingSettings => {
  const d = DEFAULT_PRODUCT_LANDING;
  const src: ProductLandingOverrides = isObject(raw) ? (raw as ProductLandingOverrides) : {};

  const sections = { ...d.sections };
  if (isObject(src.sections)) {
    for (const key of LANDING_SECTION_KEYS) {
      if (typeof src.sections[key] === "boolean") sections[key] = src.sections[key]!;
    }
  }

  const hero = isObject(src.hero) ? src.hero : {};
  const trust = Array.isArray(hero.trustBadges) ? hero.trustBadges : [];

  const features = (Array.isArray(src.features) ? src.features : [])
    .filter((f) => isObject(f) && text(f.text, ""))
    .map((f) => ({ icon: typeof f.icon === "string" ? f.icon : "", text: f.text }));

  const delivery = isObject(src.delivery) ? src.delivery : {};
  const items = Array.isArray(delivery.items) ? delivery.items : [];

  return {
    sections,
    urgency: texts(src.urgency, d.urgency),
    hero: {
      badge: text(hero.badge, d.hero.badge),
      ctaText: text(hero.ctaText, d.hero.ctaText),
      trustBadges: d.hero.trustBadges.map((t, i) => text(trust[i], t)),
    },
    features: features.length ? features : d.features,
    description: texts(src.description, d.description),
    gallery: texts(src.gallery, d.gallery),
    video: texts(src.video, d.video),
    delivery: {
      heading: text(delivery.heading, d.delivery.heading),
      items: d.delivery.items.map((item, i) => texts(items[i], item)),
    },
    floatingCtaText: text(src.floatingCtaText, d.floatingCtaText),
  };
};
