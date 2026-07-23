import React from 'react';
import { AuthProvider } from '../lib/AuthProvider';

export const metadata = {
  title: 'Contoso Analytics Portal — Genie MSAL iframe PoC',
  description: 'MSAL sign-in + native Genie iframe with no second login',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
