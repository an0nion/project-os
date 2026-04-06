/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow serverless functions to import heavy deps only at runtime
  experimental: {
    serverComponentsExternalPackages: [
      'puppeteer-core',
      '@sparticuz/chromium',
      '@slack/bolt',
    ],
  },
  // PWA share target needs multipart/form-data
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};

export default nextConfig;
