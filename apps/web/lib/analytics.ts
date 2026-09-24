import type { PostHog } from 'posthog-js';
import { analyticsRoute, type UsageEvent } from './analytics-policy';

// Keep this preference through "clear browser data" so opting out stays respected.
const preferenceKey = 'freewrite-analytics-enabled';
let client: PostHog | undefined;
export function analyticsEnabled(): boolean {
  try { return localStorage.getItem(preferenceKey) !== 'false' && navigator.doNotTrack !== '1' && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl; }
  catch { return false; }
}
export function attachAnalytics(sdk: PostHog) { client = sdk; }
export function setAnalyticsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(preferenceKey, String(enabled));
    if (enabled && analyticsEnabled()) client?.opt_in_capturing({ captureEventName: false });
    else client?.opt_out_capturing();
  } catch { /* Analytics never blocks writing, including restricted storage. */ }
}
export function trackUsage(event: UsageEvent) {
  try { if (analyticsEnabled()) client?.capture(event); } catch { /* Best effort. */ }
}
export function trackPageview(url: string) {
  const route = analyticsRoute(url);
  try { if (route && analyticsEnabled()) client?.capture('$pageview', { route }); } catch { /* Best effort. */ }
}
