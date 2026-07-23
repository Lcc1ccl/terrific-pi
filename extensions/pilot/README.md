# pilot

Phase 0 of the Pilot control-plane design. This package currently verifies activation state, direct mode contracts, AUTO input routing, and the versioned `auxiliary` `pilot_router` bridge.

It deliberately does not create Work Bundles, start Planner/Worker subagents, authorize writes, or replace the installed `mode` and `docsflow` packages. Its `terrificPi.install: false` marker keeps it out of offline-install package discovery. Do not add it to `settings.json` until the Phase 1 vertical slice is complete.

## Verify

```bash
npm run check
```
