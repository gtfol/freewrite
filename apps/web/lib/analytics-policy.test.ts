import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPayload, analyticsProperties, analyticsRoute, usageEvents } from './analytics-policy.ts';

test('page addresses never expose content identifiers, callback codes, or query strings', () => {
  assert.equal(analyticsRoute('/read/private-article?title=secret#text'), '/read/[id]');
  assert.equal(analyticsRoute('/share/secret-capability'), '/share/[id]');
  assert.equal(analyticsRoute('/s/temporary-token'), '/s/[id]');
  assert.equal(analyticsRoute('/?content=secret'), '/');
  for (const path of ['/ios/connect?code=secret', '/api/auth/callback/google', '/unknown-secret', 'https://evil.test/read/id', '/read/a/b']) assert.equal(analyticsRoute(path), null);
});
test('outbound allowlist removes content and nested SDK URL/profile properties', () => {
  const privateProperties = {
    route: '/read/[id]', distinct_id: '01234567-89ab-cdef-0123-456789abcdef',
    $current_url: 'https://freewrite.gtfol.dev/read/SECRET?token=SECRET',
    $referrer: 'https://example.com/SECRET', $set: { email: 'SECRET', $initial_current_url: 'SECRET' },
    $set_once: { $initial_referrer: 'SECRET' }, $exception_message: 'SECRET',
    content: 'SECRET', title: 'SECRET', email: 'SECRET', $screen_name: 'SECRET',
  };
  for (const event of usageEvents) {
    const safe = analyticsProperties(event, privateProperties);
    assert.ok(safe); assert.ok(!JSON.stringify(safe).includes('SECRET'));
    assert.equal(safe.distinct_id, privateProperties.distinct_id);
    assert.equal(safe.$process_person_profile, false);
    assert.equal(safe.$geoip_disable, true);
  }
  assert.equal(analyticsProperties('$pageview', { route: '/read/SECRET' }), null);
  assert.equal(analyticsProperties('$snapshot', privateProperties), null);
  assert.equal(analyticsProperties('$identify', privateProperties), null);
  assert.equal(analyticsProperties('SECRET', privateProperties), null);
  assert.equal(analyticsProperties('entry_created', { distinct_id: 'email@example.com' })?.distinct_id, undefined);
});

test('transport token survives while top-level profile and marketing metadata are discarded', () => {
  const token = 'phc_abcdefghijklmnop';
  const payload = { uuid: 'event-id', event: 'entry_created', properties: { token }, $set: { email: 'PRIVATE' }, $set_once: { $initial_current_url: 'PRIVATE' } };
  const safe = analyticsPayload(payload);
  assert.equal(safe?.properties.token, token);
  assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
  assert.ok(!Object.hasOwn(safe!, '$set'));
  assert.ok(!Object.hasOwn(safe!, '$set_once'));
});
