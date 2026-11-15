export function stripSvgTitle(markup: string): string {
  return markup
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
    .replace(/\s+role\s*=\s*(["'])img\1/gi, "");
}
