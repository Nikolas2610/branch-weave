/** Monaco theme definitions require hex even when VS Code emits CSS rgba(). */
export function normalizeThemeColor(value: string, fallback: string): string {
  const color = value.trim();
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) return color;
  if (/^#[\da-f]{3,4}$/i.test(color))
    return "#" + [...color.slice(1)].map((c) => c + c).join("");
  if (color === "transparent") return "#00000000";
  if (!/^rgba?\(/i.test(color) || !color.endsWith(")")) return fallback;
  const parts = color
    .slice(color.indexOf("(") + 1, -1)
    .trim()
    .split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4) return fallback;
  const channels = parts.map((part, index) => {
    const numeric = Number.parseFloat(part);
    const scaled = part.endsWith("%")
      ? (numeric / 100) * 255
      : index === 3
        ? numeric * 255
        : numeric;
    return Math.round(Math.max(0, Math.min(255, scaled)));
  });
  if (channels.some((n) => !Number.isFinite(n))) return fallback;
  if (channels.length === 3) channels.push(255);
  return "#" + channels.map((n) => n.toString(16).padStart(2, "0")).join("");
}
