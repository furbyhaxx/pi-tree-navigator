# Parity of the recommended intent policy with the benchmark

Run `parity-2026-10-23T13-44-39.652Z` at `d0be5231c1b256f009afd98bcadb3932e2a1cbbe`: 75 paid calls, settled spend 0.002125 USD.

Each cell is agreements/comparable cases. `requests` counts live decisions-model requests whose body hash equals a recorded benchmark request. `luna contradicts` is the live escalation, which runs only when the decisions model abstains on a replacement; `luna probe` asks Luna the contradicts question alone for every case with active items. `verdict` compares the live (kind, supersedes) with the benchmark replayed through the shipped code: against its most common repetition, and against any repetition. `unsafe accepted` counts wrong answers that passed the 0.7 gate (the benchmark's safety measure); `unsafe verdicts` also counts abstentions that left an explicit rule uncaptured.

| task | split | cases | requests | microsoft kind | microsoft contradicts | luna contradicts | luna probe | verdict (modal) | verdict (any rep) | live exact | unsafe accepted | unsafe verdicts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| intent | development | 16 | 16/16 | 16/16 | 1/1 | 1/1 | 1/1 | 16/16 | 16/16 | 15 (benchmark 15/16 reps) | 0 (benchmark 0 over reps) | 1 (benchmark 1 over reps) |
| intent | holdout | 8 | 8/8 | 8/8 | 1/1 | 0/0 | 0/1 | 8/8 | 8/8 | 6 (benchmark 18/24 reps) | 0 (benchmark 2 over reps) | 2 (benchmark 6 over reps) |
| supersession | development | 16 | 16/16 | 15/16 | 16/16 | 0/0 | 16/16 | 15/16 | 15/16 | 13 (benchmark 12/16 reps) | 0 (benchmark 0 over reps) | 3 (benchmark 4 over reps) |
| supersession | holdout | 8 | 8/8 | 6/8 | 8/8 | 0/0 | 8/8 | 7/8 | 8/8 | 6 (benchmark 18/24 reps) | 0 (benchmark 0 over reps) | 2 (benchmark 4 over reps) |

## Cases where the live verdict differs from every benchmark repetition

- `supersession-pkg-reverse-rule-de`: live rule|R2 (classifier), benchmark ephemeral|none
