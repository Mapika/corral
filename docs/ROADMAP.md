# Corral roadmap

The 1.0 promise: **trust your whole herd to it.** Someone runs their daily agent work through
Corral on every machine they own and never thinks about the plumbing. Beyond that, 2.0 points
at something bigger: the herd stops being separate machines.

## 0.5 — reaches you anywhere *(shipped)*

Web Push straight from the backend (RFC 8291/8292 on node:crypto, no relay, selftested against
the RFC vectors) with enrolment in the phone console's settings sheet; ntfy stays as the
alternative transport. Notification taps land on the session in both transports.

## 0.6 — one phone, many ranches *(shipped)*

Multi-server pairing: the herd spans the desktop, the homelab box, and the office machine, with
one merged "needs you" list. Roster merging, per-server tokens, per-server connection state,
conflict UX. Pocket mode — the agents running *on the phone itself* — joins the roster as
"this phone" and coexists with paired desktops.

## 0.7 — the overnight ranch

Corral stops being a viewer and becomes a dispatcher. A work queue: hand the herd a list of
jobs, each runs as an agent session in its own git worktree, sequentially or overnight. Your
phone buzzes when a run lands with the diff ready. A morning review surface answers "what did
the herd do while I slept" — read the diff, keep it or bounce it, from the couch. Underneath:
host telemetry (what's loaded, what's on battery) and projects-not-machines identity (a git
remote is the same project wherever it's checked out). The desktop app learns to update itself.

## 0.8 — one computer, first steps

Corral picks the machine: launch (or queue) against a *project* and placement chooses the host
that has the checkout, the agent, and free capacity — manual pick always one tap away.
Wake-on-LAN so an always-on box can rouse the big machine when the queue needs muscle; the
phone dispatches to the desktop when home, runs on-device when out. Per-project permission
defaults ("always allow Edit in this repo").

## 0.9 — hardening

Autonomy raises the stakes: an adversarial pass over SECURITY.md covering the queue and
unattended runs, cert pinning for pairing, TLS-by-default guidance, and a reliability bug-bash —
sessions survive restarts and sleeps, reconnects always converge, the roster never drifts.
Code signing and notarization land here, once installs justify the certificates. "Never lose a
session" is the actual bar for 1.0.

## 1.0 — stabilization

No new surface; fix, polish, document.

## 2.0 — the herd is one computer

The horizon that makes the 0.7/0.8 plumbing intentional: a designated always-on member that
owns the queue and schedules standing work ("every night: update deps, run the tests, open a
diff") without burning anything while idle; sessions that follow you between devices — start on
the desktop, continue on the phone on a plane, land it back on the homelab; the GPU box serving
local models to agents anywhere in the herd. Solo-first, agent-work only, a human always at the
review gate.

## Explicitly post-1.0

iOS native (the PWA + Web Push *is* the iOS story for now), tablets, Play Store, tunnels-on-phone,
APK foreground-service notifications (fully relay-free push for the app — battery trade-off).
