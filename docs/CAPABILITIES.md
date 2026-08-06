# terrific-pi Core Capabilities

This document is the current capability map for the core `terrific-pi` distribution. Historical rationale remains in `SESSION_LESSONS.md` and feature plans.

## Package Map

| Domain | Package | Entry | Responsibility |
|---|---|---|---|
| Interface | statusline | `/statusline`, automatic footer | Sole footer owner; model, usage, context, Git, runtime, and status widgets |
| Interface | appearance | `/appearance`, startup | Header and editor surfaces only |
| Interface | taskboard | `/taskboard`, `process_update` | Structured task milestones, waiting/blocked state, and task HUD |
| Interface | presentation | `/presentation`, automatic renderers | Transcript presentation, system entries, and file receipts |
| Session control | mode | `/mode` | ask/plan/edit/auto tool policy |
| Session control | fast | `/fast` | GPT/OpenAI Responses priority-tier preference and effective state |
| Session control | context | `/context` | Context occupancy inspection and explicit confirmed compaction |
| Session control | model-profile | `/profile` | Short model+thinking profiles and session/global application |
| Runtime | auxiliary | `/aux`, `aux_summarize`, `web_research`, `git_finalize` | Bounded side-model routes and canonical usage |
| Runtime | btw | `/btw` | Isolated no-tool side-channel Q&A |

The root Pi manifest loads exactly these ten extension entries and the `pi-provider-sync` skill.

## Ownership Contracts

| Surface or fact | Owner |
|---|---|
| Footer | statusline |
| Header/editor | appearance |
| Task state/HUD | taskboard |
| Transcript/tool presentation | presentation |
| Tool permission policy | mode |
| Priority request mutation | fast |
| Auxiliary usage ledger | auxiliary |

Dedicated status keys are not duplicated into generic progress. Runtime code has no cross-component source imports; integrations use Pi status, events, and session entries.

## Configuration

| File | Sections or data |
|---|---|
| `terrific.json` | appearance, auxiliary, btw, context, fast, mode, modelProfile, presentation, taskboard |
| `statusline.json` | footer widgets and layout |
| `settings.json` | root package entry and Pi model defaults |
| `models.json` | custom providers/models and provider-sync output |

All section writers preserve unknown sibling sections, which permits the separately installed Automation package to own `docsflow` without a shared runtime library.

## Optional Integrations

- Auxiliary Web Research delegates through the fixed reviewed `pi-subagents` source and uses `pi-web-access` tools.
- Missing optional packages fail explicitly without blocking the other core features.
- `terrific-pi-automation` separately provides Pilot and Docsflow. Core does not load, publish, or activate them.

## Distribution

- One root Git/npm package and one SemVer cover all core components.
- Nested component packages are private development/test boundaries.
- Skills are discovered from the root package; no copy-back or installer synchronization exists.
- Snapshot, custom offline archive, restore installer, and manifest-generation scripts are retired.
