/**
 * Root layout — Server Component (required for Next.js metadata export).
 * SW registration is handled by the client-only <PwaInit> component below.
 */

import PwaInit from './PwaInit.jsx';

export const metadata = {
  title:       'Project OS',
  description: 'Personal AI project management',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#08090c" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="ProjectOS" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body style={{ margin: 0, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', backgroundColor: '#08090c', color: '#e8eaf0', minHeight: '100dvh' }}>
        <PwaInit />
        {children}
      </body>
    </html>
  );
}
