# Glossary

Domain terms of pi-project-profile. Each concept has one term; the code, the docs and the messages use it.

**Note** — a fact about one repository that its files do not show, kept outside the repository with its author, date and evidence.
_Avoid_: memory entry, fact.

**Agent note** — a note that the agent wrote with the `remember` tool. The agent and any dream may change or remove it.
_Avoid_: AI note, model note.

**User note** — a note that the user wrote with `/profile note`. Only the user, or a manual dream that the user starts, may remove it.
_Avoid_: manual note.

**Sleep pass** — the check of the notes and overrides at session start, without a model: it flags notes that name paths that no longer exist and overrides that detection now gives. It removes nothing.
_Avoid_: dream, validation.

**Dream** — a pass in which a model checks the notes against the repository and the verification history, then removes, merges or adds evidence.
_Avoid_: cleanup, compaction, consolidation run.

**Manual dream** — a dream that the user starts with `/profile dream`: a run in the session that may also remove user notes.
_Avoid_: dream run.

**Automatic dream** — a dream that the extension starts by itself, in the background, when the notes have changed since the last dream. It changes agent notes only; it proposes the removal of a user note to the user.
_Avoid_: auto-dream, background dream.
