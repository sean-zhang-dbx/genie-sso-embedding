'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from '../lib/AuthProvider';
import { genieEmbedUrl } from '../lib/genieBootstrap';

const BRAND = '#1B3139';
const ACCENT = '#FF3621';

function Header({ who }: { who?: string | null }) {
  const { logout } = useAuth();
  return (
    <header
      style={{
        background: BRAND, color: '#fff', padding: '0 22px', height: 56,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}
    >
      <div style={{ fontWeight: 700, letterSpacing: '.5px', fontSize: 15 }}>
        CONTOSO <span style={{ opacity: 0.55, fontWeight: 400 }}>| Analytics Portal</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link
          href="/other"
          style={{
            color: '#fff', textDecoration: 'none', fontSize: 13, opacity: 0.9,
            border: '1px solid rgba(255,255,255,.4)', padding: '6px 14px', borderRadius: 6,
          }}
        >
          Other view →
        </Link>
        {who && <span style={{ fontSize: 13, opacity: 0.9 }}>{who}</span>}
        <button
          onClick={() => logout()}
          style={{
            color: '#fff', background: 'none', border: '1px solid rgba(255,255,255,.4)',
            padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>
    </header>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', background: '#eef0f2' }}>
      <div
        style={{
          margin: 'auto', padding: 40, width: 440, textAlign: 'center', background: '#fff',
          borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.08)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function Home() {
  const {
    isAuthenticated, isLoading, login, error, accessDenied,
    getUserName, getUserEmail, genieReady, geniePreparing,
    genieReconnecting, genieFrameKey,
    genieMayNeedReconnect, reconnectGenie, notifyGenieFrameLoaded,
  } = useAuth();

  if (isLoading) {
    return (<><Header /><Centered><p style={{ color: '#6b7680' }}>Loading…</p></Centered></>);
  }

  if (accessDenied) {
    return (
      <>
        <Header who={getUserEmail()} />
        <Centered>
          <h1 style={{ fontSize: 22, marginBottom: 8, color: BRAND }}>Access denied</h1>
          <p style={{ color: '#6b7680', fontSize: 13.5 }}>
            You&apos;re signed in, but not a member of the allowed group. Contact support for access.
          </p>
        </Centered>
      </>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <Header />
        <Centered>
          <h1 style={{ fontSize: 22, marginBottom: 8, color: BRAND }}>Sign in once</h1>
          <p style={{ color: '#6b7680', fontSize: 13.5, marginBottom: 24, lineHeight: 1.55 }}>
            Sign in with your organization account. After the group check, the Databricks
            session is established silently and the native Genie iframe loads — no second prompt.
          </p>
          <button
            onClick={() => login().catch(() => {})}
            style={{
              background: ACCENT, color: '#fff', border: 'none', padding: '13px 26px',
              borderRadius: 8, fontWeight: 600, fontSize: 15, cursor: 'pointer',
            }}
          >
            🔑 Sign in once
          </button>
          {error && <p style={{ color: ACCENT, fontSize: 12.5, marginTop: 16 }}>{error}</p>}
        </Centered>
      </>
    );
  }

  // Authenticated + group-approved.
  const who = getUserName() || getUserEmail();
  if (!genieReady) {
    return (
      <>
        <Header who={who} />
        <Centered>
          <h1 style={{ fontSize: 20, marginBottom: 8, color: BRAND }}>Connecting to Databricks…</h1>
          <p style={{ color: '#6b7680', fontSize: 13.5 }}>
            {geniePreparing
              ? 'A brief window establishes your Databricks session, then closes itself.'
              : 'Preparing…'}
          </p>
        </Centered>
      </>
    );
  }

  return (
    <>
      <Header who={who} />
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
        {genieMayNeedReconnect ? (
          <div
            style={{
              fontSize: 12.5, padding: '8px 18px', background: '#fff7e6',
              borderBottom: '1px solid #ffe1a8', color: '#8a5a00',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}
          >
            <span>
              If Genie below is asking you to sign in, your Databricks session may have expired
              in another window. Reconnect to restore it.
            </span>
            <button
              onClick={() => reconnectGenie().catch(() => {})}
              style={{
                background: ACCENT, color: '#fff', border: 'none', padding: '6px 14px',
                borderRadius: 6, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', flex: '0 0 auto',
              }}
            >
              Reconnect Genie
            </button>
          </div>
        ) : (
          <div
            style={{
              fontSize: 12.5, padding: '8px 18px', background: '#eefaf0',
              borderBottom: '1px solid #c7ecd0', color: '#276b3a',
            }}
          >
            <b>Signed in once.</b> Your MSAL sign-in established the Databricks session — the
            native Genie iframe below loaded with no second prompt.
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', padding: '14px 18px 18px', minHeight: 0 }}>
          <div
            style={{
              flex: 1, position: 'relative', display: 'flex', minHeight: 0, background: '#fff',
              border: '1px solid #e2e6e9', borderRadius: 10, overflow: 'hidden',
            }}
          >
            <iframe
              key={genieFrameKey}
              src={genieEmbedUrl()}
              allow="clipboard-write"
              onLoad={() => notifyGenieFrameLoaded()}
              style={{ border: 'none', width: '100%', height: '100%' }}
            />
            {genieReconnecting && (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 8,
                  background: 'rgba(255,255,255,.92)', color: BRAND,
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600 }}>Reconnecting to Genie…</div>
                <div style={{ fontSize: 12.5, color: '#6b7680' }}>
                  Restoring your Databricks session.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
