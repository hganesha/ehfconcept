"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePolledResource<T>(
  url: string,
  intervalMs: number = 5000,
  enabled: boolean = true
) {
  const [data, setData] = useState<T | null>(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [hasRefreshError, setHasRefreshError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (manual = false) => {
      if (!url) return;
      if (hasDataRef.current || manual) {
        setIsRefreshing(true);
      } else {
        setIsLoadingInitial(true);
      }

      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as T & { generatedAt?: string };
        setData(json);
        hasDataRef.current = true;
        setHasRefreshError(false);
        setErrorMessage(null);
        setLastRefreshedAt(json.generatedAt || new Date().toISOString());
      } catch (err) {
        setHasRefreshError(true);
        setErrorMessage(
          err instanceof Error ? err.message : "Telemetry endpoint unreachable"
        );
      } finally {
        setIsLoadingInitial(false);
        setIsRefreshing(false);
      }
    },
    [url]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchData(false), 0);
    return () => window.clearTimeout(timer);
  }, [fetchData]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return; // Pause polling when tab is hidden
      }
      fetchData(false);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [enabled, intervalMs, fetchData]);

  return {
    data,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh: () => fetchData(true),
  };
}
