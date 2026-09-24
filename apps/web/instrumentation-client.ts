import posthog from 'posthog-js';
import { analyticsEnabled, attachAnalytics, trackPageview } from './lib/analytics';
import { analyticsPayload, analyticsRoute } from './lib/analytics-policy';

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
// Production only; auth callbacks, previews, and local tests never initialize the SDK.
if (window.location.origin === 'https://freewrite.gtfol.dev' && analyticsRoute(window.location.href) &&
    key && /^phc_[A-Za-z0-9]{16,}$/.test(key) && host === 'https://us.i.posthog.com') {
  try {
    posthog.init(key, {
      api_host: host,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_dead_clicks: false,
      rageclick: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_feature_flags: true,
      person_profiles: 'never',
      persistence: 'localStorage',
      ip: false,
      respect_dnt: true,
      opt_out_capturing_by_default: !analyticsEnabled(),
      before_send: event => {
        if (!event || !analyticsRoute(window.location.href) || !analyticsEnabled()) return null;
        return analyticsPayload(event);
      },
    });
    attachAnalytics(posthog);
    trackPageview(window.location.href);
  } catch { /* A blocked analytics service must never prevent the app opening. */ }
}
export function onRouterTransitionStart(url: string) { trackPageview(url); }
