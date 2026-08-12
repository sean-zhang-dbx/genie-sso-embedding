'use client';

// Dummy second view used to reproduce/verify the "randomly bounced back to the
// Genie view" bug. It has NO Genie iframe. With the old code, the focus/token
// re-mint storm would eventually run startServerMint(), a full-page redirect to
// "/", yanking the user off this page back to the Genie home. With the fix,
// recovery is gated on /api/genie-status and never navigates the top window, so
// you stay here across focus/blur, tab-switches, and token renewals.

import React from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/AuthProvider';

const BRAND = '#1B3139';
const ACCENT = '#FF3621';

export default function OtherView() {
  const { isLoading, isAuthenticated, getUserName, getUserEmail } = useAuth();
  const who = getUserName() || getUserEmail();

  return (
    <>
      <header
        style={{
          background: BRAND, color: '#fff', padding: '0 22px', height: 56,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <div style={{ fontWeight: 700, letterSpacing: '.5px', fontSize: 15 }}>
          CONTOSO <span style={{ opacity: 0.55, fontWeight: 400 }}>| Other view</span>
        </div>
        {who && <span style={{ fontSize: 13, opacity: 0.9 }}>{who}</span>}
      </header>

      <div style={{ display: 'flex', height: 'calc(100vh - 56px)', background: '#eef0f2' }}>
        <div
          style={{
            margin: 'auto', padding: 40, width: 560, background: '#fff',
            borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.08)',
          }}
        >
          <h1 style={{ fontSize: 22, marginBottom: 12, color: BRAND }}>
            Other view — no Genie here
          </h1>
          <p style={{ color: '#6b7680', fontSize: 14, lineHeight: 1.6 }}>
            {isLoading
              ? 'Loading…'
              : isAuthenticated
                ? 'You are signed in. This page deliberately has no Genie iframe. Switch tabs, click away and back, leave it idle — you should STAY on this page. If the SSO recovery ever full-page-redirects, you would land back on the Genie home. That is the bug this build fixes.'
                : 'Not signed in — open the home page first to sign in, then navigate back here.'}
          </p>
          <div style={{ marginTop: 24 }}>
            <Link
              href="/"
              style={{
                display: 'inline-block', background: ACCENT, color: '#fff',
                textDecoration: 'none', padding: '11px 22px', borderRadius: 8,
                fontWeight: 600, fontSize: 14,
              }}
            >
              ← Back to Genie home
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
