# Parity of the production milestone policy with the benchmark

Run `milestone-parity-2026-10-23T14-46-22.419Z` at `991c122207c5ec7c9f8fcb66e277dd698ef52526`: 32 paid calls, settled spend 0.001648 USD; the shared ledger grew by 0.001648 USD (ceiling 0.912696 USD of billed plus held).

- requests byte-identical to the recorded `#instructions` requests: 32/32
- decision equals the benchmark's confirm of the same live answers: 16/16
- decision equals the benchmark's confirm of some recorded repetition: 16/16
- accepted answers 24, unsafe accepted 0, accepted-exact cases 8/16

| case | task | request (classifier / confirmer) | production decision | = confirm of live answers | = a recorded repetition | unsafe |
| --- | --- | --- | --- | --- | --- | --- |
| status-docs-migration-milestone | milestone-status | true / true | status=abstain boundary=b7f62a78 | yes | yes | 0 |
| status-web-notice-sharp-versions | milestone-status | true / true | status=continue boundary=abstain | yes | yes | 0 |
| status-icon-sprite-milestone | milestone-status | true / true | status=milestone boundary=c499f833 | yes | yes | 0 |
| status-cart-i18n-partially-verified-de | milestone-status | true / true | status=continue boundary=abstain | yes | yes | 0 |
| status-pricing-service-milestone-de | milestone-status | true / true | status=milestone boundary=637b783b | yes | yes | 0 |
| status-welcome-mail-asks-layout-gsw | milestone-status | true / true | status=await-user boundary=none | yes | yes | 0 |
| status-last-page-fix-milestone | milestone-status | true / true | status=milestone boundary=7b1da8eb | yes | yes | 0 |
| status-prod-rollout-migration-approval-de | milestone-status | true / true | status=await-user boundary=abstain | yes | yes | 0 |
| boundary-lint-cleanup-hook-started | milestone-boundary | true / true | status=abstain boundary=66f71336 | yes | yes | 0 |
| boundary-healthz-then-probes | milestone-boundary | true / true | status=continue boundary=130d5d41 | yes | yes | 0 |
| boundary-github-scopes-final | milestone-boundary | true / true | status=milestone boundary=b7da05c4 | yes | yes | 0 |
| boundary-worker-oom-question-answered | milestone-boundary | true / true | status=continue boundary=abstain | yes | yes | 0 |
| boundary-ledger-format-golden-missing-de | milestone-boundary | true / true | status=continue boundary=abstain | yes | yes | 0 |
| boundary-ios-target-then-gitignore | milestone-boundary | true / true | status=continue boundary=aa72b9de | yes | yes | 0 |
| boundary-mobile-lcp-analysis-de | milestone-boundary | true / true | status=continue boundary=abstain | yes | yes | 0 |
| boundary-phone-e164-premature-claim | milestone-boundary | true / true | status=milestone boundary=acbbb58d | yes | yes | 0 |
