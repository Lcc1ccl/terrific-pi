---
name: project-docs
description: Shared method, templates, and quality bar for docsflow agents (research → product → interface → delivery).
---

# Project Docs (docsflow)

## Status labels

- **Verified** — primary evidence
- **Inferred** — reasonable but not proven
- **Unknown** — missing; do not invent
- **Blocked** — needs external decision

## Output layout

Parent docsflow writes markdown products. Default is **local session cwd**:

```text
<session-cwd>/docsflow/
  00_Research.md
  01_Product_Spec.md
  02_Interface_Spec.md
  03_Engineering_Handoff.md
  *.draft.md
```

Optional Obsidian vault mode (`docsflow.vaultEnabled=true`):

```text
2_Career/01-INDIE/开发/<projectSlug>/docsflow/
  ...same files...
```

Artifact paths are always relative to that `docsflow/` folder.

## Artifact Contract

Return one JSON object with: status, summary, decisions, assumptions, evidence, unresolved, risks, recommended_next_step, artifacts[{path,content}], confidence.

## Pipeline

```text
research → product → interface → delivery → ready
```

Hermes / MOA / Discord review is optional, never required.

## Templates

- `research-template.md`
- `product-spec-template.md`
- `interface-spec-template.md`
- `engineering-handoff-template.md`
