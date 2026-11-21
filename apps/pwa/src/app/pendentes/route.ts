import { NextResponse } from "next/server";

/**
 * Legacy `/pendentes` (aprovações) aponta para a página canônica de contas a
 * pagar. Redirect permanente 308, preservando método e query, para que links
 * antigos não quebrem sem duplicar renderização de página.
 */
export function GET(request: Request): NextResponse {
  const url = new URL(request.url);
  const target = new URL("/compromissos", url);
  const merged = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(url.search)) {
    if (key !== "aba") merged.append(key, value);
  }
  target.search = merged.toString();
  return NextResponse.redirect(target, 308);
}
