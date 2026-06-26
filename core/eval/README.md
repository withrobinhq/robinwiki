# Robin core evals

Evalite + autoevals harness for the fragmentation and classification agents.
The corpora are hand-authored and checked in; rerunning evals shouldn't
regenerate them.

## Run

```sh
pnpm -F @robin/core eval         # full sweep
pnpm -F @robin/core eval:watch   # iterative dev loop
```

`eval` exits non-zero if the average score falls below `scoreThreshold` in
`evalite.config.ts`. The default threshold is intentionally low until the
baselines settle — raise it once the corpora have been reviewed.

## Layout

```
core/eval/
  evalite.config.ts          # runner config
  lib/
    fixture-loader.ts        # YAML/JSON → typed fixture loader
    scorers.ts               # autoevals re-exports + custom shape scorer
  fragmentation/
    fixtures/*.json          # 20 hand-crafted entries (eval corpus)
    fragmentation.eval.ts    # evalite suite
  classification/
    fixtures/*.json          # 20 hand-crafted fragments (eval corpus)
    classification.eval.ts   # evalite suite
```

## Why evalite + autoevals

Evalite is vitest-shaped (fast watch loop, native TS). Autoevals ships the
LLM-as-judge scorers (`Factuality`, `AnswerRelevancy`, plus pure-function
`ExactMatch` / `Levenshtein`), so we get a structured eval runner without
hand-rolling one.

## Retrieval evals

Retrieval evals live at `core/eval/retrieval/` on the same harness — the
corpus shape is a thin wrapper around qrels. Adding another suite is one new
directory and one new `.eval.ts` file.
