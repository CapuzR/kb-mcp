import type { NextRequest } from 'next/server';

/**
 * Compute the public base URL of this deployment. Prefer the explicit
 * PUBLIC_BASE_URL env var; otherwise derive from request headers (Vercel sets
 * x-forwarded-host / x-forwarded-proto reliably).
 */
export function getBaseUrl(req?: NextRequest | Request): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (req) {
    const headers = 'headers' in req ? req.headers : new Headers();
    const host = headers.get('x-forwarded-host') ?? headers.get('host');
    const proto = headers.get('x-forwarded-proto') ?? 'https';
    if (host) return `${proto}://${host}`;
  }
  // Vercel env fallback
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}
