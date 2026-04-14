/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent Next from trying to bundle these native/Node-only modules.
  serverExternalPackages: ['tar', '@octokit/rest', '@octokit/auth-app'],
  // Don't attempt to optimize these CSS/fonts for our pure-API app.
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // OAuth 2.0 discovery endpoints live under /.well-known; Next's App Router
  // doesn't handle dot-prefixed folders cleanly, so we rewrite to clean paths.
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/oauth/authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth/protected-resource',
      },
      {
        source: '/.well-known/oauth-authorization-server/api/mcp',
        destination: '/api/oauth/authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource/api/mcp',
        destination: '/api/oauth/protected-resource',
      },
    ];
  },
};

export default nextConfig;
