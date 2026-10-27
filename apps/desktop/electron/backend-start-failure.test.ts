import assert from 'node:assert/strict'

import { test } from 'vitest'

import { BackendPortAnnouncementTimeoutError } from './backend-ready'
import { shouldLatchBackendStartFailure, shouldLatchRemoteReauthFailure, shouldRetryLocalPortTimeout } from './backend-start-failure'

test('retries a local port timeout only once, leaving other failures for recovery UI', () => {
  const timeout = new BackendPortAnnouncementTimeoutError(90_000)
  assert.equal(shouldRetryLocalPortTimeout({ attemptedRemote: false, error: timeout, retriesLeft: 1 }), true)
  assert.equal(shouldRetryLocalPortTimeout({ attemptedRemote: false, error: timeout, retriesLeft: 0 }), false)
  assert.equal(shouldRetryLocalPortTimeout({ attemptedRemote: true, error: timeout, retriesLeft: 1 }), false)
  assert.equal(shouldRetryLocalPortTimeout({ attemptedRemote: false, error: new Error('spawn failed'), retriesLeft: 1 }), false)
})

test('latches a LOCAL backend failure so the install-retry loop is broken', () => {
  assert.equal(shouldLatchBackendStartFailure({ attemptedRemote: false }), true)
})

test('never latches a REMOTE failure so recovery stays retryable without a restart', () => {
  // A lapsed OAuth session / mint timeout / host briefly unreachable across a
  // laptop sleep must not wedge the app: the next connect has to re-attempt and
  // re-mint against the refreshed session.
  assert.equal(shouldLatchBackendStartFailure({ attemptedRemote: true }), false)
})

test('the two branches are mutually exclusive (a failure either latches or stays retryable)', () => {
  for (const attemptedRemote of [true, false]) {
    const latched = shouldLatchBackendStartFailure({ attemptedRemote })
    assert.equal(latched, !attemptedRemote)
  }
})

test('latches a CONFIRMED remote reauth failure so the overlay stays clickable', () => {
  // Without this the non-latching remote path re-runs startYoutab on every
  // getConnection/api call, re-emits running:true, and the overlay hides
  // itself — the "Sign in" button flickers away before it can be clicked.
  assert.equal(shouldLatchRemoteReauthFailure({ attemptedRemote: true, isReauth: true }), true)
})

test('does not latch a transient remote failure as reauth', () => {
  // A mint timeout or a host unreachable across sleep must still self-heal.
  assert.equal(shouldLatchRemoteReauthFailure({ attemptedRemote: true, isReauth: false }), false)
})

test('never latches a LOCAL failure as reauth (that is backendStartFailure job)', () => {
  assert.equal(shouldLatchRemoteReauthFailure({ attemptedRemote: false, isReauth: true }), false)
  assert.equal(shouldLatchRemoteReauthFailure({ attemptedRemote: false, isReauth: false }), false)
})

test('the two latches never fire for the same failure', () => {
  // They are complementary, not overlapping: local failures latch via
  // backendStartFailure, confirmed remote reauth latches via its own flag.
  for (const attemptedRemote of [true, false]) {
    for (const isReauth of [true, false]) {
      const start = shouldLatchBackendStartFailure({ attemptedRemote })
      const reauth = shouldLatchRemoteReauthFailure({ attemptedRemote, isReauth })
      assert.ok(!(start && reauth), `both latched for remote=${attemptedRemote} reauth=${isReauth}`)
    }
  }
})
