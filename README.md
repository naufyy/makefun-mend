# mend

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naufyy/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naufyy/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies edits that AI models write to a tree of text files. It reads four formats: unified diffs (including ones
with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. Lines are matched at three
tiers: exact, then ignoring trailing whitespace, then ignoring surrounding whitespace, with re-indentation. Either every
file is changed or nothing is. `SPEC.md` is the full contract. Node 22, standard library only.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file (absent or `-`: standard input); the working directory is the tree's root.
- `--format=` is one of `auto` (the default), `unified`, `search-replace`, `v4a` or `json`.
- `--check` reports what would change without writing anything; `--strict` matches lines exactly.

Run the practice set: `node check.ts <kit>/program/generator/practice.json`.

---

Built for a competition on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122).
