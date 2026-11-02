---
version: 1
id: "policy-precedence-verification"
title: "Automatic policy scope precedence verification"
description: "Regression, runtime and terminal evidence for project settings winning over global model policies."
type: "analysis"
created: "2026-11-02T07:59:37+01:00"
updated: "2026-11-02T07:59:37+01:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

- Cause: flattening model overrides before runtime resolution let Global model
  settings overwrite Project and Session base settings.
- Resolution: apply each scope's base and model matches before advancing scopes;
  materialize defaults once. Keep editable merged values separately.
- `just check`: typecheck and lint passed; 1,634 tests passed, zero failed.
- `just rpc-verify`: passed; `anchor` registered from the checkout's extension.
- Regression: both controller cases failed before the fix with premature summary
  calls. Afterward, disabled stays inactive, and enabled compacts above the Project
  threshold rather than the Global model threshold.
- Invalid-policy tests cover fail-closed behavior and valid higher-scope repair of
  a malformed same-pattern entry; untrusted projects are not read.
- Live Pi-Bolt: isolated synthetic configuration and an offline-only dummy model;
  Global model policy enabled at 200k, trusted Project disabled at 400k. Selected
  settings and `settings show` report disabled/400k. Dark/fullscreen and
  light/regular passed at 36, 57, 80 and 140 columns. Raw captures are in `captures/`.
  Fixture configuration bytes remained unchanged; disposable terminals were stopped.
- Hot-path benchmark: five rounds of 100,000 resolutions with three scopes and
  overlapping patterns, after 20,000 warmup calls. Median baseline 2.59 microseconds
  per call; patched 4.10 microseconds per call. No I/O occurs during resolution.
- Independent review accepted scope ordering, state propagation and UI separation;
  the flagged same-pattern invalidity repair is implemented and regression-tested.
- User explicitly waived provider calls for this fix and approved push plus package
  update. No live-provider acceptance is claimed. Real settings and private session
  contents were not changed.
