# Corral roadmap to 1.0

The 1.0 promise: **trust your whole herd to it.** Someone runs their daily agent work through
Corral on every machine they own and never thinks about the plumbing. Five pillars, roughly one
minor version each; reach you (0.5) → everywhere (0.6) → trustably (0.7–0.9).

## 0.5 — reaches you anywhere *(shipped)*

Web Push straight from the backend (RFC 8291/8292 on node:crypto, no relay, selftested against
the RFC vectors) with enrolment in the phone console's settings sheet; ntfy stays as the
alternative transport. Notification taps land on the session in both transports.

## 0.6 — one phone, many ranches

Multi-server pairing: the herd spans the desktop, the homelab box, and the office machine, with
one merged "needs you" list. Roster merging, per-server tokens, per-server connection state,
conflict UX. The biggest deferred item and the headline feature of the run-up.

## 0.7 — builds people can trust

Windows signing + macOS notarization, Tauri updater on desktop (the APK's update check is the
mobile half, shipped in 0.4). Release channels if the updater needs them.

## 0.8 — depth where agents live

Per-project permission defaults ("always allow Edit in this repo"), a queue for "run these three
things tonight", worktree-first flows. Breadth (more agents) matters less than making the
supported ones feel first-class.

## 0.9 — hardening

Cert pinning for pairing, TLS-by-default guidance, an adversarial pass over SECURITY.md, a
reliability bug-bash: sessions survive restarts and sleeps, reconnects always converge, the
roster never drifts. "Never lose a session" is the actual bar for 1.0.

## 1.0 — stabilization

No new surface; fix, polish, document.

## Explicitly post-1.0

iOS native (the PWA + Web Push *is* the iOS story for now), tablets, Play Store, tunnels-on-phone,
APK foreground-service notifications (fully relay-free push for the app — battery trade-off).
