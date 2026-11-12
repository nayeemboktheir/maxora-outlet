import { useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

interface GAConfig {
  measurementId: string;
  gtmId: string;
  gaEnabled: boolean;
  gtmEnabled: boolean;
}

export interface GAItem {
  item_id: string;
  item_name: string;
  price?: number;
  quantity?: number;
  item_category?: string;
}

// Module-level so every component shares one config load and one init
let gaConfig: GAConfig | null = null;
let configPromise: Promise<GAConfig | null> | null = null;
let initialized = false;

const getDataLayer = (): unknown[] => {
  window.dataLayer = window.dataLayer || [];
  return window.dataLayer;
};

const isAdminRoute = () => window.location.pathname.startsWith('/admin');

// Direct gtag.js mode (GA4 on, GTM off)
const usesGtagDirect = () =>
  !!gaConfig && gaConfig.gaEnabled && !!gaConfig.measurementId && !gaConfig.gtmEnabled && typeof window.gtag === 'function';

const initializeGTM = (gtmId: string) => {
  if (document.querySelector(`script[src*="gtm.js?id=${gtmId}"]`)) return;
  console.log('[GTM] Initializing:', gtmId);

  getDataLayer().push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
  document.head.appendChild(script);

  const noscript = document.createElement('noscript');
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.googletagmanager.com/ns.html?id=${gtmId}`;
  iframe.height = '0';
  iframe.width = '0';
  iframe.style.display = 'none';
  iframe.style.visibility = 'hidden';
  noscript.appendChild(iframe);
  document.body.insertBefore(noscript, document.body.firstChild);
};

const initializeGA4 = (measurementId: string) => {
  if (document.querySelector(`script[src*="gtag/js?id=${measurementId}"]`)) return;
  console.log('[GA4] Initializing:', measurementId);

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);

  getDataLayer();
  window.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: true });
};

const loadConfig = (): Promise<GAConfig | null> => {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', ['ga_measurement_id', 'gtm_id', 'ga_enabled', 'gtm_enabled']);
      if (error) throw error;

      const config: GAConfig = { measurementId: '', gtmId: '', gaEnabled: false, gtmEnabled: false };
      data?.forEach((s) => {
        if (s.key === 'ga_measurement_id') config.measurementId = s.value;
        if (s.key === 'gtm_id') config.gtmId = s.value;
        if (s.key === 'ga_enabled') config.gaEnabled = s.value === 'true';
        if (s.key === 'gtm_enabled') config.gtmEnabled = s.value === 'true';
      });
      gaConfig = config;

      if (!initialized) {
        initialized = true;
        if (config.gtmEnabled && config.gtmId) initializeGTM(config.gtmId.trim());
        // GA4 direct only when GTM is off, to avoid double tracking
        if (config.gaEnabled && config.measurementId && !config.gtmEnabled) {
          initializeGA4(config.measurementId.trim());
        }
      }
      return config;
    } catch (err) {
      console.error('[GA] Failed to load settings:', err);
      configPromise = null; // allow retry
      return null;
    }
  })();
  return configPromise;
};

/**
 * Push a GA4 ecommerce event to the dataLayer (for GTM) and to gtag (direct GA4 mode).
 * dataLayer is a queue, so pushes made before gtm.js loads are still processed.
 */
export const pushEcommerceEvent = (event: string, ecommerce: Record<string, unknown>) => {
  if (typeof window === 'undefined' || isAdminRoute()) return;
  const layer = getDataLayer();
  layer.push({ ecommerce: null }); // clear previous ecommerce object (GA4 recommendation)
  layer.push({ event, ecommerce });
  if (usesGtagDirect()) window.gtag('event', event, ecommerce);
};

/** Push a non-ecommerce event to the dataLayer / gtag. */
export const pushDataLayerEvent = (event: string, params: Record<string, unknown> = {}) => {
  if (typeof window === 'undefined' || isAdminRoute()) return;
  getDataLayer().push({ event, ...params });
  if (usesGtagDirect()) window.gtag('event', event, params);
};

/**
 * Hook for Google Analytics 4 and Google Tag Manager tracking
 */
export const useGoogleAnalytics = () => {
  useEffect(() => {
    loadConfig();
  }, []);

  const getClientId = useCallback((): string | null => {
    try {
      const match = document.cookie.match(/_ga=([^;]+)/);
      if (match) {
        const parts = match[1].split('.');
        if (parts.length >= 4) return `${parts[2]}.${parts[3]}`;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const getSessionId = useCallback((): string | null => {
    try {
      if (!gaConfig?.measurementId) return null;
      const suffix = gaConfig.measurementId.replace('G-', '');
      const match = document.cookie.match(new RegExp(`_ga_${suffix}=([^;]+)`));
      if (match) {
        const parts = match[1].split('.');
        if (parts.length >= 3) return parts[2];
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const trackPageView = useCallback((pagePath?: string, pageTitle?: string) => {
    if (typeof window === 'undefined' || isAdminRoute()) return;
    const params = {
      page_path: pagePath || window.location.pathname,
      page_location: window.location.href,
      page_title: pageTitle || document.title,
    };
    // Always queue for GTM (custom event name avoids clashing with GA4's automatic page_view)
    getDataLayer().push({ event: 'virtual_page_view', ...params });
  }, []);

  const trackViewItem = useCallback((item: GAItem) => {
    pushEcommerceEvent('view_item', { currency: 'BDT', value: item.price, items: [item] });
  }, []);

  const trackAddToCart = useCallback((item: GAItem) => {
    const quantity = item.quantity || 1;
    pushEcommerceEvent('add_to_cart', {
      currency: 'BDT',
      value: (item.price || 0) * quantity,
      items: [{ ...item, quantity }],
    });
  }, []);

  const trackBeginCheckout = useCallback((items: GAItem[], value: number) => {
    pushEcommerceEvent('begin_checkout', { currency: 'BDT', value, items });
  }, []);

  const trackPurchase = useCallback((params: {
    transactionId: string;
    value: number;
    items: GAItem[];
    shipping?: number;
    tax?: number;
  }) => {
    pushEcommerceEvent('purchase', {
      transaction_id: params.transactionId,
      currency: 'BDT',
      value: params.value,
      shipping: params.shipping || 0,
      tax: params.tax || 0,
      items: params.items,
    });
  }, []);

  const trackEvent = useCallback((eventName: string, eventParams?: Record<string, unknown>) => {
    pushDataLayerEvent(eventName, eventParams);
  }, []);

  return {
    trackPageView,
    trackViewItem,
    trackAddToCart,
    trackBeginCheckout,
    trackPurchase,
    trackEvent,
    getClientId,
    getSessionId,
  };
};
