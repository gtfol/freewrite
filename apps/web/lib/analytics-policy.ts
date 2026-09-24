/** Explicit events only. No content, account identifiers, URLs, or error messages. */
export const usageEvents = [
  '$pageview', 'entry_created', 'history_opened', 'settings_opened',
  'timer_started', 'reader_edit_started', 'reader_listen_toggled',
] as const;
export type UsageEvent = typeof usageEvents[number];
const routes = ['/', '/read', '/read/[id]', '/share/[id]', '/s/[id]', '/settings'] as const;

export function analyticsRoute(input: string): string | null {
  try {
    const url = new URL(input, 'https://freewrite.gtfol.dev');
    if (url.origin !== 'https://freewrite.gtfol.dev') return null;
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path === '/' || path === '/read' || path === '/settings') return path;
    if (/^\/(read|share|s)\/[^/]+$/.test(path)) return `/${path.split('/')[1]}/[id]`;
  } catch { /* Unrecognized navigation is not analytics data. */ }
  return null;
}

export function analyticsProperties(event: string, properties: Record<string, unknown>): Record<string, unknown> | null {
  if (!(usageEvents as readonly string[]).includes(event)) return null;
  const safe: Record<string, unknown> = { platform: 'web', $process_person_profile: false, $geoip_disable: true, $ip: null };
  // SDK-generated random IDs only; never identify with an account ID.
  for (const key of ['distinct_id', '$device_id', '$session_id', '$window_id']) {
    const value = properties[key];
    if (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) safe[key] = value;
  }
  // The public ingestion token is required by PostHog's event transport.
  if (typeof properties.token === 'string' && /^phc_[A-Za-z0-9]{16,}$/.test(properties.token)) safe.token = properties.token;
  safe.$lib = 'web';
  if (typeof properties.$lib_version === 'string' && /^\d+(\.\d+){1,3}$/.test(properties.$lib_version)) safe.$lib_version = properties.$lib_version;
  if (event === '$pageview') {
    if (!(routes as readonly unknown[]).includes(properties.route)) return null;
    safe.route = properties.route;
    safe.$pathname = properties.route;
    safe.$current_url = `https://freewrite.gtfol.dev${properties.route}`;
  }
  return safe;
}

export function analyticsPayload(event: { uuid: string; event: string; properties: Record<string, unknown>; timestamp?: Date }) {
  const properties = analyticsProperties(event.event, event.properties);
  // $set/$set_once can also appear at the top level, outside properties.
  return properties ? { uuid: event.uuid, event: event.event, timestamp: event.timestamp, properties } : null;
}
