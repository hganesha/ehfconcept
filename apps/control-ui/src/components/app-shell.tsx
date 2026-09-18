"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Boxes,
  Activity,
  Shield,
  Server,
  RefreshCw,
  Menu,
  X,
  Hexagon,
  FolderKanban,
  DraftingCompass,
} from "lucide-react";
import { FreshnessIndicator, ReadinessBadge } from "./primitives";

const NAV_ITEMS = [
  { href: "/overview", label: "Overview", short: "Overview", icon: LayoutDashboard },
  { href: "/harnesses", label: "Harnesses", short: "Plans", icon: Boxes },
  { href: "/author", label: "Author Plane", short: "Author", icon: DraftingCompass },
  { href: "/runs", label: "Runs", short: "Runs", icon: Activity },
  { href: "/cases", label: "Cases", short: "Cases", icon: FolderKanban },
  { href: "/gateway", label: "Capability Gateway", short: "Gateway", icon: Shield },
  { href: "/system", label: "System", short: "System", icon: Server },
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    pathname === href || (href !== "/overview" && pathname.startsWith(href));
}

function RailFooter({
  runtimeMode,
  fixture,
  pollIntervalSec,
  hasRefreshError,
}: {
  runtimeMode: "OpenRouter" | "Recorded";
  fixture: boolean;
  pollIntervalSec: number;
  hasRefreshError: boolean;
}) {
  return (
    <div className="border-t border-line p-3 xl:p-4">
      {/* Full rail ≥1280px */}
      <dl className="mono hidden space-y-2 text-[11px] xl:block">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">environment</dt>
          <dd className="chip">local</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">runtime mode</dt>
          <dd className="flex items-center gap-1">
            <span className="chip">{runtimeMode}</span>
            {fixture && <span className="chip chip-warn">Fixture</span>}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">telemetry</dt>
          <dd className={hasRefreshError ? "text-danger" : "text-evergreen"}>
            {hasRefreshError ? "stale · 32s" : `live · ${pollIntervalSec}s`}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line pt-2 text-ink-3">
          <dt>v0.1.0</dt>
          <dd>local</dd>
        </div>
      </dl>

      {/* Icon rail 960–1279px */}
      <div
        className="mono flex flex-col items-center gap-1.5 text-[10px] text-ink-3 xl:hidden"
        title={`environment: local · runtime: ${runtimeMode}${
          fixture ? " (Fixture)" : ""
        } · build v0.1.0 (local)`}
      >
        <span className="chip px-1.5 py-0.5">local</span>
        <span className={hasRefreshError ? "text-danger" : "text-evergreen"}>
          {hasRefreshError ? "stale" : `${pollIntervalSec}s`}
        </span>
      </div>
    </div>
  );
}

export function AppShell({
  title,
  breadcrumb,
  readiness = "Ready",
  runtimeMode = "Recorded",
  fixture = true,
  lastRefreshedAt,
  pollIntervalSec = 5,
  isRefreshing = false,
  hasRefreshError = false,
  compactCounts,
  actions,
  onManualRefresh,
  children,
}: {
  title: string;
  breadcrumb?: { label: string; href?: string }[];
  readiness?: "Ready" | "Degraded" | "Unavailable";
  runtimeMode?: "OpenRouter" | "Recorded";
  fixture?: boolean;
  lastRefreshedAt: string | null;
  pollIntervalSec?: number;
  isRefreshing?: boolean;
  hasRefreshError?: boolean;
  compactCounts?: React.ReactNode;
  actions?: React.ReactNode;
  onManualRefresh: () => void;
  children: React.ReactNode;
}) {
  const isActive = useIsActive();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-evergreen focus:px-4 focus:py-2 focus:text-xs focus:font-semibold focus:text-white"
      >
        Skip to main content
      </a>

      {/* ============ Left rail: icons 960–1279px, full ≥1280px ============ */}
      <aside
        aria-label="Primary navigation"
        className="sticky top-0 hidden h-screen w-[72px] shrink-0 flex-col justify-between border-r border-line bg-surface nav:flex xl:w-[248px]"
      >
        <div className="min-h-0 flex-1">
          <div className="flex h-16 items-center gap-2.5 border-b border-line px-4 xl:px-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-evergreen text-white">
              <Hexagon className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <span className="hidden min-w-0 xl:block">
              <span className="block truncate text-[13px] font-bold tracking-tight">
                Harness Control
              </span>
              <span className="mono block truncate text-[11px] text-ink-3">
                compiled runtime · poc
              </span>
            </span>
          </div>

          <nav className="space-y-1 p-2.5 xl:p-3">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-lg border px-2.5 py-2.5 text-xs font-semibold transition-colors xl:px-3 ${
                    active
                      ? "border-[#bcd9c7] bg-mint text-evergreen"
                      : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
                  } justify-center xl:justify-start`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="hidden xl:inline">{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <RailFooter
          runtimeMode={runtimeMode}
          fixture={fixture}
          pollIntervalSec={pollIntervalSec}
          hasRefreshError={hasRefreshError}
        />
      </aside>

      {/* ============ Mobile drawer (<960px) ============ */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 nav:hidden">
          <button
            type="button"
            aria-label="Close navigation overlay"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-[#222d27]/45"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col justify-between border-r border-line bg-surface"
          >
            <div>
              <div className="flex h-16 items-center justify-between border-b border-line px-4">
                <span className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-evergreen text-white">
                    <Hexagon className="h-4.5 w-4.5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-[13px] font-bold">
                      Harness Control
                    </span>
                    <span className="mono block text-[11px] text-ink-3">
                      compiled runtime · poc
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-lg p-2 text-ink-2 hover:bg-surface-2"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="space-y-1 p-3">
                {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setDrawerOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-xs font-semibold ${
                        active
                          ? "border-[#bcd9c7] bg-mint text-evergreen"
                          : "border-transparent text-ink-2"
                      }`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>
            <RailFooter
              runtimeMode={runtimeMode}
              fixture={fixture}
              pollIntervalSec={pollIntervalSec}
              hasRefreshError={hasRefreshError}
            />
          </div>
        </div>
      )}

      {/* ============ Main column ============ */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation menu"
                className="btn btn-ghost btn-xs nav:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>

              <div className="min-w-0">
                {breadcrumb && breadcrumb.length > 0 && (
                  <nav
                    aria-label="Breadcrumb"
                    className="flex items-center gap-1.5 text-[11px] text-ink-3"
                  >
                    {breadcrumb.map((b, i) => (
                      <React.Fragment key={i}>
                        {b.href ? (
                          <Link
                            href={b.href}
                            className="truncate font-medium hover:text-ink hover:underline"
                          >
                            {b.label}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">{b.label}</span>
                        )}
                        <span aria-hidden="true">/</span>
                      </React.Fragment>
                    ))}
                  </nav>
                )}
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-base font-bold tracking-tight text-ink sm:text-lg">
                    {title}
                  </h1>
                  {fixture && (
                    <span
                      className="chip chip-warn chip-mono hidden sm:inline-flex"
                      title="Backend is running in deterministic Recorded mode"
                    >
                      Fixture
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {compactCounts && (
                <span className="mono hidden text-[11.5px] text-ink-2 lg:inline">
                  {compactCounts}
                </span>
              )}
              <ReadinessBadge status={readiness} />
              <span className="hidden sm:inline-flex">
                <FreshnessIndicator
                  lastRefreshedAt={lastRefreshedAt}
                  pollIntervalSec={pollIntervalSec}
                  isRefreshing={isRefreshing}
                  hasError={hasRefreshError}
                />
              </span>
              <button
                type="button"
                onClick={onManualRefresh}
                aria-label="Refresh telemetry now"
                className="btn btn-ghost"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${
                    isRefreshing ? "animate-spin text-evergreen" : "text-ink-3"
                  }`}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              {actions}
            </div>
          </div>
        </header>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {isRefreshing ? "Refreshing operational telemetry" : ""}
        </div>

        <main
          id="main-content"
          className="mx-auto w-full max-w-[1680px] flex-1 px-4 py-5 pb-24 sm:px-6 sm:py-6 lg:px-8 nav:pb-10"
        >
          {children}
        </main>
      </div>

      {/* ============ Mobile bottom tab bar (<960px) ============ */}
      <nav
        aria-label="Primary navigation (compact)"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-7 border-t border-line bg-surface/95 backdrop-blur-md nav:hidden"
      >
        {NAV_ITEMS.map(({ href, short, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-1 py-2.5 text-[10.5px] font-semibold ${
                active ? "text-evergreen" : "text-ink-3"
              }`}
            >
              <Icon className="h-4.5 w-4.5" aria-hidden="true" />
              <span>{short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
