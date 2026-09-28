import { useState, useEffect, memo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getEmbedUrl } from "@/lib/videoEmbed";
import {
  ChevronLeft,
  ChevronRight,
  Truck,
  Shield,
  CheckCircle2,
  ShoppingBag,
  Play,
  Users,
  Clock,
  Flame,
  Gift,
  Star,
} from "lucide-react";
import type { ProductLandingSettings } from "@/lib/productLanding";

// ====== Optimized Image ======
export const OptimizedImage = memo(({ src, alt, className, priority = false }: { 
  src: string; alt: string; className?: string; priority?: boolean;
}) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {!loaded && <div className="absolute inset-0 bg-muted animate-pulse" />}
      <img
        src={src}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`w-full h-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
});
OptimizedImage.displayName = 'OptimizedImage';

export interface LandingProduct {
  name: string;
  price: number;
  original_price?: number;
  images: string[];
  short_description?: string;
}

/** Fill `{n}` and render `**text**` segments in bold. */
const RichText = ({ text, n, boldClassName = "font-bold" }: { text: string; n?: number; boldClassName?: string }) => (
  <>
    {text
      .replace(/\{n\}/g, n === undefined ? "" : String(n))
      .split(/\*\*(.+?)\*\*/)
      .map((part, i) =>
        i % 2 ? <span key={i} className={boldClassName}>{part}</span> : part ? <span key={i}>{part}</span> : null
      )}
  </>
);

// ====== Urgency Counter ======
export const UrgencyBanner = memo(({ content }: { content: ProductLandingSettings["urgency"] }) => {
  const [viewers] = useState(() => Math.floor(Math.random() * 15) + 8);
  const [stock] = useState(() => Math.floor(Math.random() * 10) + 3);

  return (
    <div className="bg-gradient-to-r from-primary via-primary to-accent text-primary-foreground py-2.5 px-4">
      <div className="container mx-auto flex items-center justify-center gap-6 text-sm font-medium flex-wrap">
        <span className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
          </span>
          <Users className="h-4 w-4" />
          <span className="whitespace-pre-wrap"><RichText text={content.viewersText} n={viewers} /></span>
        </span>
        <span className="hidden sm:block text-white/50">|</span>
        <span className="flex items-center gap-2">
          <Flame className="h-4 w-4 animate-pulse" />
          <span className="whitespace-pre-wrap"><RichText text={content.stockText} n={stock} boldClassName="font-bold text-white" /></span>
        </span>
      </div>
    </div>
  );
});
UrgencyBanner.displayName = 'UrgencyBanner';

// ====== Hero Section ======
export const HeroSection = memo(({ product, content, currentImage, setCurrentImage, onBuyNow }: {
  product: LandingProduct; content: ProductLandingSettings["hero"]; currentImage: number; setCurrentImage: (i: number) => void; onBuyNow: () => void;
}) => {
  const images = product.images || [];
  const discount = product.original_price 
    ? Math.round(((product.original_price - product.price) / product.original_price) * 100) 
    : 0;

  useEffect(() => {
    if (images.length <= 1) return;
    const timer = setInterval(() => setCurrentImage((currentImage + 1) % images.length), 4000);
    return () => clearInterval(timer);
  }, [currentImage, images.length, setCurrentImage]);

  return (
    <section className="gradient-dark py-8 md:py-14">
      <div className="container mx-auto px-4">
        <div className="grid md:grid-cols-2 gap-8 md:gap-12 items-center max-w-5xl mx-auto">
          {/* Image */}
          <div className="relative max-w-lg mx-auto w-full">
            {discount > 0 && (
              <Badge className="absolute top-4 left-4 z-20 bg-destructive text-destructive-foreground text-base px-4 py-2 font-bold shadow-lg">
                -{discount}% ছাড়
              </Badge>
            )}
            
            <div className="relative aspect-square rounded-3xl overflow-hidden shadow-2xl bg-card ring-4 ring-white/10">
              {images[currentImage] && (
                <OptimizedImage src={images[currentImage]} alt={product.name} className="w-full h-full" priority />
              )}
              
              {images.length > 1 && (
                <>
                  <button
                    onClick={() => setCurrentImage((currentImage - 1 + images.length) % images.length)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 bg-background/95 backdrop-blur-sm rounded-full p-2.5 shadow-xl hover:scale-110 transition-all border border-border"
                    aria-label="Previous"
                  >
                    <ChevronLeft className="h-5 w-5 text-foreground" />
                  </button>
                  <button
                    onClick={() => setCurrentImage((currentImage + 1) % images.length)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 bg-background/95 backdrop-blur-sm rounded-full p-2.5 shadow-xl hover:scale-110 transition-all border border-border"
                    aria-label="Next"
                  >
                    <ChevronRight className="h-5 w-5 text-foreground" />
                  </button>
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 bg-black/30 backdrop-blur-sm px-3 py-2 rounded-full">
                    {images.map((_, idx) => (
                      <button
                        key={idx}
                        onClick={() => setCurrentImage(idx)}
                        className={`h-2 rounded-full transition-all duration-300 ${idx === currentImage ? "bg-accent w-8" : "bg-white/60 w-2 hover:bg-white"}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Thumbnails */}
            {images.length > 1 && (
              <div className="flex gap-3 mt-4 justify-center">
                {images.slice(0, 5).map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentImage(idx)}
                    className={`w-16 h-16 rounded-xl overflow-hidden border-2 transition-all duration-300 ${
                      idx === currentImage 
                        ? "border-accent scale-110 shadow-lg ring-2 ring-accent/30" 
                        : "border-transparent opacity-60 hover:opacity-100 hover:scale-105"
                    }`}
                  >
                    <OptimizedImage src={img} alt="" className="w-full h-full" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Product Info */}
          <div className="text-primary-foreground space-y-5 text-center md:text-left">
            <div>
              <span className="inline-block bg-accent/20 text-accent px-3 py-1 rounded-full text-sm font-medium mb-3">
                {content.badge}
              </span>
              <h1 className="text-3xl md:text-5xl font-bold leading-tight">{product.name}</h1>
            </div>
            
            {product.short_description && (
              <p className="text-base md:text-lg text-primary-foreground/80 leading-relaxed">{product.short_description}</p>
            )}

            {/* Price */}
            <div className="flex items-baseline gap-4 flex-wrap py-3 px-5 bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 justify-center md:justify-start">
              <span className="text-4xl md:text-5xl font-bold text-accent">৳{product.price.toLocaleString()}</span>
              {product.original_price && product.original_price > product.price && (
                <span className="text-xl text-primary-foreground/50 line-through">৳{product.original_price.toLocaleString()}</span>
              )}
              {discount > 0 && (
                <Badge className="bg-accent text-accent-foreground font-bold px-3 py-1">
                  ৳{(product.original_price! - product.price).toLocaleString()} সেভ!
                </Badge>
              )}
            </div>

            {/* CTA */}
            <Button
              onClick={onBuyNow}
              size="lg"
              className="w-full md:w-auto px-12 py-7 text-xl font-bold bg-gradient-to-r from-accent to-primary hover:from-primary hover:to-accent text-accent-foreground rounded-2xl shadow-cta hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
            >
              <ShoppingBag className="mr-2 h-6 w-6" />
              {content.ctaText}
            </Button>

            {/* Trust Badges */}
            <div className="grid grid-cols-3 gap-3 pt-3">
              {[Shield, Truck, Gift].map((icon, idx) => ({
                icon,
                text: content.trustBadges[idx],
                color: "text-accent",
              })).map((item, idx) => (
                <div key={idx} className="text-center p-3 rounded-xl bg-white/5 backdrop-blur-sm border border-white/10 hover:bg-white/10 transition-colors">
                  <item.icon className={`h-6 w-6 mx-auto mb-1.5 ${item.color}`} />
                  <span className="text-xs font-medium text-primary-foreground/90">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});
HeroSection.displayName = 'HeroSection';

// ====== Features ======
export const FeaturesBanner = memo(({ features }: { features: ProductLandingSettings["features"] }) => (
  <section className="bg-gradient-to-r from-primary via-accent to-primary py-5 overflow-hidden relative">
    <div className="container mx-auto px-4 relative">
      <div className="flex flex-wrap justify-center gap-4 md:gap-8">
        {features.map((item, idx) => (
          <div key={idx} className="flex items-center gap-2 bg-white/20 backdrop-blur-sm px-4 py-2 rounded-full text-white font-semibold text-sm shadow-sm hover:bg-white/30 transition-colors">
            {item.icon && <span>{item.icon}</span>}
            <CheckCircle2 className="h-4 w-4 text-white" />
            <span>{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  </section>
));
FeaturesBanner.displayName = 'FeaturesBanner';

// ====== Gallery ======
export const GallerySection = memo(({ images, content }: { images: string[]; content: ProductLandingSettings["gallery"] }) => {
  if (!images || images.length < 2) return null;
  return (
    <section className="py-12 md:py-16 gradient-elegant">
      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <span className="inline-block bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-3">
              {content.badge}
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground">{content.heading}</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {images.slice(0, 6).map((img, idx) => (
              <div key={idx} className="group aspect-square rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300 ring-1 ring-border">
                <OptimizedImage src={img} alt="" className="w-full h-full group-hover:scale-110 transition-transform duration-500" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
});
GallerySection.displayName = 'GallerySection';

// ====== Video ======
export const VideoSection = memo(({ videoUrl, content }: { videoUrl?: string; content: ProductLandingSettings["video"] }) => {
  if (!videoUrl) return null;

  const raw = (videoUrl || "").trim();
  const isRawHtml = raw.startsWith("<");
  
  const extractAspectInfo = (html: string) => {
    const widthMatch = html.match(/width=["']?(\d+)/i);
    const heightMatch = html.match(/height=["']?(\d+)/i);
    const width = widthMatch ? parseInt(widthMatch[1]) : 16;
    const height = heightMatch ? parseInt(heightMatch[1]) : 9;
    return { aspectRatio: width / height, isPortrait: height > width };
  };

  const aspectInfo = isRawHtml ? extractAspectInfo(raw) : { aspectRatio: 16/9, isPortrait: false };

  return (
    <section className="py-10 md:py-16 gradient-dark">
      <div className="container mx-auto px-4">
        <div className="text-center mb-8">
          <span className="inline-flex items-center gap-2 bg-accent/20 text-accent px-4 py-1.5 rounded-full text-sm font-medium mb-3">
            <Play className="h-4 w-4" />
            {content.badge}
          </span>
          <h2 className="text-2xl md:text-3xl font-bold text-white">{content.heading}</h2>
        </div>

        <div className={`max-w-3xl mx-auto ${aspectInfo.isPortrait ? "max-w-sm" : ""}`}>
          <div
            className="relative rounded-2xl overflow-hidden shadow-2xl bg-foreground/90 ring-1 ring-white/10"
            style={{ aspectRatio: aspectInfo.isPortrait ? "9/16" : "16/9" }}
          >
            {isRawHtml ? (
              <div
                className="absolute inset-0 [&>iframe]:!absolute [&>iframe]:!inset-0 [&>iframe]:!w-full [&>iframe]:!h-full [&>iframe]:!border-0"
                dangerouslySetInnerHTML={{ __html: raw }}
              />
            ) : raw.match(/\.(mp4|webm|ogg)$/i) ? (
              <video
                src={raw}
                controls
                className="absolute inset-0 w-full h-full object-contain"
                preload="metadata"
                playsInline
              />
            ) : (
              <iframe
                src={getEmbedUrl(raw)}
                title="Video"
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                referrerPolicy="no-referrer-when-downgrade"
                className="absolute inset-0 w-full h-full border-0"
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
});
VideoSection.displayName = "VideoSection";

// ====== Product Description ======
export const ProductDescriptionSection = memo(({ description, content }: { description?: string; content: ProductLandingSettings["description"] }) => {
  if (!description || !description.trim()) return null;
  
  const lines = description.split('\n').filter(line => line.trim());
  
  return (
    <section className="py-10 md:py-16 bg-gradient-to-b from-background to-secondary/30">
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-8">
            <span className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-3">
              {content.badge}
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground font-bengali">{content.heading}</h2>
          </div>
          
          <div className="bg-card rounded-2xl shadow-xl border border-border overflow-hidden">
            <div className="bg-gradient-to-r from-primary to-accent p-4">
              <h3 className="text-lg font-bold text-primary-foreground font-bengali">
                {content.cardTitle}
              </h3>
            </div>
            
            <div className="p-6">
              <ul className="space-y-3">
                {lines.map((line, idx) => {
                  const cleanLine = line
                    .replace(/^[\s◊◆●○▪▫•✓✔✅👉👍🔘🌴\-\*\u25CA\u25C6\u25CF\u25CB\u25AA\u25AB]+/g, '')
                    .trim();
                  if (!cleanLine) return null;
                  
                  return (
                    <li 
                      key={idx}
                      className="p-4 rounded-xl bg-gradient-to-r from-primary/5 to-accent/5 border border-primary/10 hover:shadow-md transition-all duration-300"
                    >
                      <span className="text-foreground font-medium text-base md:text-lg leading-relaxed font-bengali flex items-start gap-3">
                        <CheckCircle2 className="h-5 w-5 text-accent mt-1 flex-shrink-0" />
                        {cleanLine}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            
            {/* Trust Footer */}
            <div className="bg-gradient-to-r from-accent/10 to-primary/10 p-4 border-t border-border">
              <p className="text-center text-primary font-medium font-bengali flex items-center justify-center gap-2">
                <Star className="h-4 w-4 text-accent" />
                {content.footerText}
                <Star className="h-4 w-4 text-accent" />
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});
ProductDescriptionSection.displayName = 'ProductDescriptionSection';

// ====== Delivery Info ======
const DELIVERY_STYLES = [
  { icon: Truck, color: "bg-accent" },
  { icon: Clock, color: "bg-primary" },
  { icon: Shield, color: "bg-accent" },
];

export const DeliverySection = memo(({ content }: { content: ProductLandingSettings["delivery"] }) => (
  <section className="py-8 md:py-12 bg-card">
    <div className="container mx-auto px-4">
      <h2 className="text-xl md:text-2xl font-bold text-center text-foreground mb-6">{content.heading}</h2>
      <div className="grid md:grid-cols-3 gap-4 max-w-3xl mx-auto">
        {content.items.map((item, idx) => ({ ...item, ...DELIVERY_STYLES[idx % DELIVERY_STYLES.length] })).map((item, idx) => (
          <div key={idx} className="flex items-center gap-3 p-4 bg-secondary/50 rounded-xl border border-border hover:shadow-md transition-all">
            <div className={`w-12 h-12 ${item.color} rounded-xl flex items-center justify-center flex-shrink-0`}>
              <item.icon className="h-6 w-6 text-white" />
            </div>
            <div>
              <p className="font-bold text-foreground">{item.title}</p>
              <p className="text-sm text-muted-foreground">{item.sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
));
DeliverySection.displayName = 'DeliverySection';
