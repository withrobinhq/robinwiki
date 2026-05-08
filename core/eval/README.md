# Robin core evals

Evalite + autoevals harness for the fragmentation (Component #7) and
classification (Component #8) agents. The corpora are hand-authored and
checked in; rerunning evals shouldn't regenerate them.

## Run

```sh
pnpm -F @robin/core eval         # full sweep
pnpm -F @robin/core eval:watch   # iterative dev loop
```

`eval` exits non-zero if the average score falls below `scoreThreshold` in
`evalite.config.ts`. The default threshold is intentionally low until the
baselines settle — bump it after Phyl has reviewed the corpora.

## Layout

```
core/eval/
  evalite.config.ts          # runner config
  lib/
    fixture-loader.ts        # YAML/JSON → typed fixture loader
    scorers.ts               # autoevals re-exports + custom shape scorer
  fragmentation/
    fixtures/*.json          # 20 hand-crafted entries (Component #7 corpus)
    fragmentation.eval.ts    # evalite suite
  classification/
    fixtures/*.json          # 20 hand-crafted fragments (Component #8 corpus)
    classification.eval.ts   # evalite suite
```

## Why evalite + autoevals

Evalite is vitest-shaped (fast watch loop, native TS). Autoevals ships the
LLM-as-judge scorers (`Factuality`, `AnswerRelevancy`, plus pure-function
`ExactMatch` / `Levenshtein`). The combination matches the gbrain shape from
the original D2 plan without us hand-rolling the runner.

## Coordination with Stream G

Stream G owns retrieval evals at `core/eval/retrieval/`. Same harness, same
runner — the corpus shape is a thin wrapper around qrels. Adding a third
suite is one new directory and one new `.eval.ts` file.
