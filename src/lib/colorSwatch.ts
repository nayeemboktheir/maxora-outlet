// Swatch colours for common English / Bangla colour names, shared by the
// landing page colour pickers and the admin colour editor.
export const SWATCH_COLORS: [string, string][] = [
  ["off white", "#f8f5ee"], ["অফ হোয়াইট", "#f8f5ee"],
  ["navy", "#1e3a8a"], ["sky", "#38bdf8"], ["আকাশি", "#38bdf8"],
  ["maroon", "#7f1d1d"], ["মেরুন", "#7f1d1d"], ["wine", "#722f37"],
  ["black", "#111827"], ["কালো", "#111827"],
  ["white", "#ffffff"], ["সাদা", "#ffffff"],
  ["cream", "#f3e9d2"], ["beige", "#d9c5a0"], ["peach", "#fbbf9e"],
  ["red", "#dc2626"], ["লাল", "#dc2626"],
  ["pink", "#ec4899"], ["গোলাপি", "#ec4899"], ["magenta", "#c026d3"],
  ["lavender", "#c4b5fd"], ["purple", "#7e22ce"], ["বেগুনি", "#7e22ce"],
  ["teal", "#0d9488"], ["mint", "#98e4c9"], ["olive", "#6b7a2e"],
  ["green", "#16a34a"], ["সবুজ", "#16a34a"],
  ["blue", "#2563eb"], ["নীল", "#2563eb"],
  ["mustard", "#d4a017"], ["yellow", "#facc15"], ["হলুদ", "#facc15"],
  ["orange", "#f97316"], ["কমলা", "#f97316"],
  ["coffee", "#6f4e37"], ["chocolate", "#5c3317"], ["brown", "#7c4a1e"], ["বাদামি", "#7c4a1e"],
  ["silver", "#c0c0c0"], ["gold", "#d4af37"], ["সোনালি", "#d4af37"],
  ["grey", "#9ca3af"], ["gray", "#9ca3af"], ["ধূসর", "#9ca3af"],
];

export const swatchColor = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, hex] of SWATCH_COLORS) {
    const hit = /^[\x20-\x7e]+$/.test(key)
      ? new RegExp(`\\b${key}\\b`).test(lower)
      : lower.includes(key);
    if (hit) return hex;
  }
  return undefined;
};
