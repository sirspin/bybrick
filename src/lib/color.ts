// A business picks one accent colour. Buttons and bars use it, so text on top of it must stay
// readable whatever they pick: choose white or near-black, whichever contrasts more.

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function readableOn(hex: string): "#ffffff" | "#111111" {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#111111") ? "#ffffff" : "#111111";
}

/** CSS custom properties for a business's accent, safe to put in a style attribute. */
export function accentVars(hex: string): Record<string, string> {
  const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#111111";
  return { "--accent": safe, "--on-accent": readableOn(safe) };
}
