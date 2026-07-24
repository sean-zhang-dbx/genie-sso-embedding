/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // avoid double-invoking the bootstrap popup in dev
  // Produce a self-contained .next/standalone server (only required deps) so the
  // Azure deploy stays small and starts with plain `node server.js` — no full
  // node_modules upload, no reliance on the `next` bin being on PATH.
  output: 'standalone',
  // NOTE: A headers()/middleware no-cache rule on the app-shell HTML was tried to
  // avoid the post-deploy stale-shell white screen, but Next.js serves the root
  // route from its full-route prerender cache (x-nextjs-cache: HIT), whose baked-in
  // Cache-Control overrides both. It is a benign, one-refresh, deploy-only edge
  // case (only affects tabs already open at deploy time). Documented as such rather
  // than worked around. See the setup guide's operational notes.
};
module.exports = nextConfig;
