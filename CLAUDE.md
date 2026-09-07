# CLAUDE.md

## `docs/human_only/` — authoritative, do not edit

Human-authored specs for the Tool Generator Server (TGS). **Never modify these files.**
They are the source of truth; everything else in `docs/` is derived from them.

- **Read from it** freely — it is the reference for TGS behavior and the STS tool contract.
- **Write to `docs/llm_generated/` instead.** That set is a reconciled, deduplicated
  rendering of the same specs: one file per screen, conflicts resolved once.
- **Conflicts between human_only files are already resolved.** Before "fixing" an
  inconsistency, check the reconciliation log in `docs/llm_generated/00-INDEX.md` —
  it records all 15 known discrepancies and which version won.
- **Changing a spec?** Edit `docs/human_only/` only if the user explicitly asks.
  Otherwise update `docs/llm_generated/` and note the divergence in `00-INDEX.md`.

`llm_ignore/full_conversation.md` is the raw design transcript both sets came from.
It is tracked in git but excluded from assistant context — cite it only if asked.
