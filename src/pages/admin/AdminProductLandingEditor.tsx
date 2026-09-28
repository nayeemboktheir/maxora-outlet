import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Eye, Smartphone, Monitor, Package, LayoutTemplate, Plus, Trash2, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

import { MultiImageUploader } from "@/components/landing-builder/MultiImageUploader";
import {
  UrgencyBanner,
  HeroSection,
  FeaturesBanner,
  GallerySection,
  VideoSection,
  ProductDescriptionSection,
  DeliverySection,
} from "@/components/product-landing/Sections";
import {
  DEFAULT_PRODUCT_LANDING,
  LANDING_SECTION_KEYS,
  LANDING_SECTION_LABELS,
  ProductLandingSettings,
  LandingSectionKey,
  resolveLandingSettings,
} from "@/lib/productLanding";

interface ProductFields {
  images: string[];
  price: string;
  original_price: string;
  short_description: string;
  long_description: string;
  video_url: string;
}

const emptyProduct: ProductFields = {
  images: [],
  price: "",
  original_price: "",
  short_description: "",
  long_description: "",
  video_url: "",
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Editing state keeps the admin's raw overrides: a blank string means "use the
 * default", which the inputs show as their placeholder. Features are edited as
 * a whole list, so an untouched product starts from the default list.
 */
const toEditState = (raw: unknown): ProductLandingSettings => {
  const d = DEFAULT_PRODUCT_LANDING;
  const src = obj(raw);
  const hero = obj(src.hero);
  const delivery = obj(src.delivery);
  const trust = Array.isArray(hero.trustBadges) ? hero.trustBadges : [];
  const items = Array.isArray(delivery.items) ? delivery.items : [];
  const group = <T extends { [K in keyof T]: string }>(value: unknown, defaults: T): T => {
    const g = obj(value);
    return Object.fromEntries(Object.keys(defaults).map((k) => [k, str(g[k])])) as T;
  };

  return {
    sections: resolveLandingSettings(raw).sections,
    urgency: group(src.urgency, d.urgency),
    hero: {
      badge: str(hero.badge),
      ctaText: str(hero.ctaText),
      trustBadges: d.hero.trustBadges.map((_, i) => str(trust[i])),
    },
    features: resolveLandingSettings(raw).features.map((f) => ({ ...f })),
    description: group(src.description, d.description),
    gallery: group(src.gallery, d.gallery),
    video: group(src.video, d.video),
    delivery: {
      heading: str(delivery.heading),
      items: d.delivery.items.map((item, i) => group(items[i], item)),
    },
    floatingCtaText: str(src.floatingCtaText),
  };
};

type TextGroup = "urgency" | "description" | "gallery" | "video";

const TextField = ({
  label,
  value,
  placeholder,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) => (
  <div className="space-y-1">
    <Label className="text-xs">{label}</Label>
    {multiline ? (
      <Textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} rows={2} className="text-sm" />
    ) : (
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
    )}
  </div>
);

const SectionCard = ({
  title,
  sectionKey,
  landing,
  onToggle,
  children,
}: {
  title: string;
  sectionKey?: LandingSectionKey;
  landing: ProductLandingSettings;
  onToggle: (key: LandingSectionKey, value: boolean) => void;
  children: React.ReactNode;
}) => {
  const visible = sectionKey ? landing.sections[sectionKey] : true;
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {sectionKey && (
          <div className="flex items-center gap-2">
            <Label htmlFor={`show-${sectionKey}`} className="text-xs text-muted-foreground">
              {visible ? "Shown" : "Hidden"}
            </Label>
            <Switch
              id={`show-${sectionKey}`}
              checked={visible}
              onCheckedChange={(checked) => onToggle(sectionKey, checked)}
            />
          </div>
        )}
      </CardHeader>
      {visible && <CardContent className="space-y-3">{children}</CardContent>}
    </Card>
  );
};

const AdminProductLandingEditor = () => {
  const { productId } = useParams();
  const queryClient = useQueryClient();

  const [product, setProduct] = useState<ProductFields>(emptyProduct);
  const [landing, setLanding] = useState<ProductLandingSettings>(() => toEditState({}));
  const [activeTab, setActiveTab] = useState<"product" | "content">("content");
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [currentImage, setCurrentImage] = useState(0);

  const { data: existing, isLoading, error } = useQuery({
    queryKey: ["admin-product-landing", productId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!productId,
  });

  useEffect(() => {
    if (!existing) return;
    setProduct({
      images: existing.images || [],
      price: existing.price != null ? String(existing.price) : "",
      original_price: existing.original_price != null ? String(existing.original_price) : "",
      short_description: existing.short_description || "",
      long_description: existing.long_description || "",
      video_url: existing.video_url || "",
    });
    setLanding(toEditState(existing.landing_settings));
  }, [existing]);

  const resolved = useMemo(() => resolveLandingSettings(landing), [landing]);
  const d = DEFAULT_PRODUCT_LANDING;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const price = Number(product.price);
      if (!product.price.trim() || !Number.isFinite(price) || price <= 0) {
        throw new Error("Enter a valid price");
      }
      const originalPrice = product.original_price.trim() ? Number(product.original_price) : null;
      if (originalPrice !== null && (!Number.isFinite(originalPrice) || originalPrice <= 0)) {
        throw new Error("Enter a valid original price, or leave it empty");
      }

      const { error } = await supabase
        .from("products")
        .update({
          images: product.images,
          price,
          original_price: originalPrice,
          short_description: product.short_description || null,
          long_description: product.long_description || null,
          video_url: product.video_url.trim() || null,
          landing_settings: JSON.parse(JSON.stringify(landing)) as Json,
        })
        .eq("id", productId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-product-landing", productId] });
      queryClient.invalidateQueries({ queryKey: ["admin-products-for-landing"] });
      queryClient.invalidateQueries({ queryKey: ["product-landing"] });
      toast.success("Landing page saved!");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to save landing page");
    },
  });

  const setGroup = <K extends TextGroup>(key: K, patch: Partial<ProductLandingSettings[K]>) =>
    setLanding((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const toggleSection = (key: LandingSectionKey, value: boolean) =>
    setLanding((prev) => ({ ...prev, sections: { ...prev.sections, [key]: value } }));

  const setTrustBadge = (index: number, value: string) =>
    setLanding((prev) => ({
      ...prev,
      hero: { ...prev.hero, trustBadges: prev.hero.trustBadges.map((t, i) => (i === index ? value : t)) },
    }));

  const setFeature = (index: number, patch: Partial<{ icon: string; text: string }>) =>
    setLanding((prev) => ({
      ...prev,
      features: prev.features.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));

  const setDeliveryItem = (index: number, patch: Partial<{ title: string; sub: string }>) =>
    setLanding((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        items: prev.delivery.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      },
    }));

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error || !existing) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Product not found</p>
        <Button variant="outline" asChild>
          <Link to="/admin/landing-pages">Back to Landing Pages</Link>
        </Button>
      </div>
    );
  }

  const previewPrice = Number(product.price) || 0;
  const previewOriginal = Number(product.original_price) || undefined;

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b px-4 py-2 flex items-center justify-between bg-background z-10 gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/admin/landing-pages">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <p className="font-semibold text-lg truncate">{existing.name}</p>
            <p className="text-xs text-muted-foreground truncate">/step/{existing.slug}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border rounded-md p-1">
            <Button
              variant={previewMode === "desktop" ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setPreviewMode("desktop")}
            >
              <Monitor className="h-4 w-4" />
            </Button>
            <Button
              variant={previewMode === "mobile" ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setPreviewMode("mobile")}
            >
              <Smartphone className="h-4 w-4" />
            </Button>
          </div>

          <Button variant="outline" size="sm" asChild>
            <a href={`/step/${existing.slug}`} target="_blank" rel="noopener noreferrer">
              <Eye className="mr-1 h-4 w-4" />
              View
            </a>
          </Button>

          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            <Save className="mr-1 h-4 w-4" />
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Editor */}
        <div className="w-96 border-r flex flex-col bg-muted/30">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="flex flex-col h-full">
            <TabsList className="grid w-full grid-cols-2 mx-2 mt-2" style={{ width: "calc(100% - 16px)" }}>
              <TabsTrigger value="content" className="text-xs">
                <LayoutTemplate className="h-3 w-3 mr-1" />
                Landing content
              </TabsTrigger>
              <TabsTrigger value="product" className="text-xs">
                <Package className="h-3 w-3 mr-1" />
                Product
              </TabsTrigger>
            </TabsList>

            <ScrollArea className="flex-1">
              <div className="p-3">
                <TabsContent value="content" className="mt-0 space-y-4">
                  <p className="text-xs text-muted-foreground">
                    Only this product's landing page uses this text. Leave a field empty to use the default shown in grey.
                  </p>

                  <SectionCard title={LANDING_SECTION_LABELS.urgency} sectionKey="urgency" landing={landing} onToggle={toggleSection}>
                    <p className="text-xs text-muted-foreground">
                      <code>{"{n}"}</code> is replaced by the number. Wrap text in <code>**</code> to make it bold.
                    </p>
                    <TextField label="Viewers text" value={landing.urgency.viewersText} placeholder={d.urgency.viewersText} onChange={(v) => setGroup("urgency", { viewersText: v })} />
                    <TextField label="Stock text" value={landing.urgency.stockText} placeholder={d.urgency.stockText} onChange={(v) => setGroup("urgency", { stockText: v })} />
                  </SectionCard>

                  <SectionCard title="Hero" landing={landing} onToggle={toggleSection}>
                    <TextField label="Badge" value={landing.hero.badge} placeholder={d.hero.badge} onChange={(v) => setLanding((p) => ({ ...p, hero: { ...p.hero, badge: v } }))} />
                    <TextField label="Button text" value={landing.hero.ctaText} placeholder={d.hero.ctaText} onChange={(v) => setLanding((p) => ({ ...p, hero: { ...p.hero, ctaText: v } }))} />
                    {landing.hero.trustBadges.map((value, i) => (
                      <TextField key={i} label={`Trust badge ${i + 1}`} value={value} placeholder={d.hero.trustBadges[i]} onChange={(v) => setTrustBadge(i, v)} />
                    ))}
                  </SectionCard>

                  <SectionCard title={LANDING_SECTION_LABELS.features} sectionKey="features" landing={landing} onToggle={toggleSection}>
                    {landing.features.map((feature, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input value={feature.icon} onChange={(e) => setFeature(i, { icon: e.target.value })} placeholder="✨" className="h-8 w-14 text-center text-sm" />
                        <Input value={feature.text} onChange={(e) => setFeature(i, { text: e.target.value })} placeholder="Feature text" className="h-8 text-sm" />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setLanding((p) => ({ ...p, features: p.features.filter((_, idx) => idx !== i) }))}
                          title="Remove"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setLanding((p) => ({ ...p, features: [...p.features, { icon: "", text: "" }] }))}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add feature
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setLanding((p) => ({ ...p, features: d.features.map((f) => ({ ...f })) }))}
                        title="Reset to default features"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    </div>
                  </SectionCard>

                  <SectionCard title={LANDING_SECTION_LABELS.description} sectionKey="description" landing={landing} onToggle={toggleSection}>
                    <TextField label="Badge" value={landing.description.badge} placeholder={d.description.badge} onChange={(v) => setGroup("description", { badge: v })} />
                    <TextField label="Heading" value={landing.description.heading} placeholder={d.description.heading} onChange={(v) => setGroup("description", { heading: v })} />
                    <TextField label="Card title" value={landing.description.cardTitle} placeholder={d.description.cardTitle} onChange={(v) => setGroup("description", { cardTitle: v })} />
                    <TextField label="Footer text" value={landing.description.footerText} placeholder={d.description.footerText} onChange={(v) => setGroup("description", { footerText: v })} />
                    <p className="text-xs text-muted-foreground">The bullet points come from the long description in the Product tab.</p>
                  </SectionCard>

                  <SectionCard title={LANDING_SECTION_LABELS.gallery} sectionKey="gallery" landing={landing} onToggle={toggleSection}>
                    <TextField label="Badge" value={landing.gallery.badge} placeholder={d.gallery.badge} onChange={(v) => setGroup("gallery", { badge: v })} />
                    <TextField label="Heading" value={landing.gallery.heading} placeholder={d.gallery.heading} onChange={(v) => setGroup("gallery", { heading: v })} />
                    <p className="text-xs text-muted-foreground">Shown when the product has 2 or more images.</p>
                  </SectionCard>

                  <SectionCard title={LANDING_SECTION_LABELS.video} sectionKey="video" landing={landing} onToggle={toggleSection}>
                    <TextField label="Badge" value={landing.video.badge} placeholder={d.video.badge} onChange={(v) => setGroup("video", { badge: v })} />
                    <TextField label="Heading" value={landing.video.heading} placeholder={d.video.heading} onChange={(v) => setGroup("video", { heading: v })} />
                    <p className="text-xs text-muted-foreground">Shown when the product has a video URL.</p>
                  </SectionCard>

                  <SectionCard title={LANDING_SECTION_LABELS.delivery} sectionKey="delivery" landing={landing} onToggle={toggleSection}>
                    <TextField
                      label="Heading"
                      value={landing.delivery.heading}
                      placeholder={d.delivery.heading}
                      onChange={(v) => setLanding((p) => ({ ...p, delivery: { ...p.delivery, heading: v } }))}
                    />
                    {landing.delivery.items.map((item, i) => (
                      <div key={i} className="grid grid-cols-2 gap-2">
                        <TextField label={`Item ${i + 1} title`} value={item.title} placeholder={d.delivery.items[i].title} onChange={(v) => setDeliveryItem(i, { title: v })} />
                        <TextField label="Subtitle" value={item.sub} placeholder={d.delivery.items[i].sub} onChange={(v) => setDeliveryItem(i, { sub: v })} />
                      </div>
                    ))}
                  </SectionCard>

                  <SectionCard title="Mobile floating button" landing={landing} onToggle={toggleSection}>
                    <TextField
                      label="Button text"
                      value={landing.floatingCtaText}
                      placeholder={d.floatingCtaText}
                      onChange={(v) => setLanding((p) => ({ ...p, floatingCtaText: v }))}
                    />
                  </SectionCard>
                </TabsContent>

                <TabsContent value="product" className="mt-0 space-y-4">
                  <p className="text-xs text-amber-600 font-medium">
                    ⚠️ These fields belong to the product, so changes also show on the normal product page.
                  </p>

                  <Card>
                    <CardContent className="pt-6 space-y-4">
                      <MultiImageUploader
                        label="Images"
                        value={product.images}
                        onChange={(images) => {
                          setProduct((p) => ({ ...p, images }));
                          setCurrentImage(0);
                        }}
                      />

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Price (৳)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={product.price}
                            onChange={(e) => setProduct((p) => ({ ...p, price: e.target.value }))}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Original price (৳)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={product.original_price}
                            onChange={(e) => setProduct((p) => ({ ...p, original_price: e.target.value }))}
                            placeholder="Optional"
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">Short description</Label>
                        <Textarea
                          value={product.short_description}
                          onChange={(e) => setProduct((p) => ({ ...p, short_description: e.target.value }))}
                          rows={2}
                          className="text-sm"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">Long description (one bullet per line)</Label>
                        <Textarea
                          value={product.long_description}
                          onChange={(e) => setProduct((p) => ({ ...p, long_description: e.target.value }))}
                          rows={8}
                          className="text-sm"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">Video URL or embed code</Label>
                        <Textarea
                          value={product.video_url}
                          onChange={(e) => setProduct((p) => ({ ...p, video_url: e.target.value }))}
                          placeholder="https://youtube.com/... or <iframe ...>"
                          rows={2}
                          className="text-sm font-mono"
                        />
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        </div>

        {/* Right Panel - Preview */}
        <div className="flex-1 bg-muted/50 overflow-auto p-4">
          <div
            className={`mx-auto bg-background shadow-lg transition-all duration-300 overflow-hidden ${
              previewMode === "mobile" ? "max-w-[375px]" : "max-w-[1200px]"
            }`}
          >
            {resolved.sections.urgency && <UrgencyBanner content={resolved.urgency} />}
            <HeroSection
              product={{
                name: existing.name,
                price: previewPrice,
                original_price: previewOriginal,
                images: product.images,
                short_description: product.short_description,
              }}
              content={resolved.hero}
              currentImage={Math.min(currentImage, Math.max(product.images.length - 1, 0))}
              setCurrentImage={setCurrentImage}
              onBuyNow={() => {}}
            />
            {resolved.sections.features && <FeaturesBanner features={resolved.features} />}
            {resolved.sections.description && (
              <ProductDescriptionSection description={product.long_description} content={resolved.description} />
            )}
            {resolved.sections.gallery && <GallerySection images={product.images} content={resolved.gallery} />}
            {resolved.sections.video && <VideoSection videoUrl={product.video_url.trim()} content={resolved.video} />}
            {resolved.sections.delivery && <DeliverySection content={resolved.delivery} />}
            <div className="py-10 px-4 text-center text-sm text-muted-foreground border-t border-dashed">
              Order form (size, colour, customer details) appears here on the live page.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminProductLandingEditor;
