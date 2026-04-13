/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent Next from trying to bundle these native/Node-only modules.
  serverExternalPackages: ['simple-git', '@octokit/rest', '@octokit/auth-app'],
  // Don't attempt to optimize these CSS/fonts for our pure-API app.
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;
