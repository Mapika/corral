import assert from 'node:assert/strict';
import { applicationServerKeyBytes, subscriptionParams } from './webPushClient.mjs';

// applicationServerKeyBytes: base64url -> bytes, tolerant of missing padding
{
  const bytes = applicationServerKeyBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  assert.equal(bytes.length, 65);            // uncompressed P-256 point
  assert.equal(bytes[0], 4);
  assert.deepEqual([...applicationServerKeyBytes('AQID')], [1, 2, 3]);
  assert.deepEqual([...applicationServerKeyBytes('_w')], [255]);   // url-safe alphabet
  assert.equal(applicationServerKeyBytes('').length, 0);
}

// subscriptionParams: flatten PushSubscription.toJSON(), reject malformed
assert.deepEqual(
  subscriptionParams({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'pk', auth: 'as' } }),
  { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'pk', auth: 'as' });
assert.equal(subscriptionParams({ endpoint: 'http://insecure/x', keys: { p256dh: 'pk', auth: 'as' } }), null);
assert.equal(subscriptionParams({ endpoint: 'https://x/y', keys: { p256dh: '', auth: 'as' } }), null);
assert.equal(subscriptionParams({ endpoint: 'https://x/y' }), null);
assert.equal(subscriptionParams(null), null);

console.log('webPushClient tests ok');
