# Step Definitions (§24 scaffolding)

This directory will host one descriptor per step type, replacing the
duplicated information that lives across:

- `server/automation/builderTools.js` (LLM tool schemas, ~600 lines of
  builder helpers)
- `server/core/automationRunner.js` (`switch(step.type)` dispatch)
- `server/automation/validate.js` (per-type validation)
- `agent-hub/src/components/admin/AITasksDesigner/Builder/flow/SettingsForm.jsx`
  (the 1774-line god component)

Each `*.def.js` file exports:

```js
module.exports = {
  id: 'aggregate',
  label: 'Aggregate',
  category: 'data',
  inputsSchema: { /* JSON Schema */ },
  outputsSchema: { /* JSON Schema */ },
  dryRunSample: { ... },
  sideEffectsClass: 'reversible',
  uiHints: { ... },
  builderToolSchema: { /* function schema for the LLM */ },
  executor: async (step, ctx, runState, mode) => { /* ... */ },
};
```

Consumers query these from one place via `getStepDef(type)` so changes
to a step type land in one file instead of four.

Phase 2 lands the directory + a couple of the simplest step types
(`set`, `wait`, `datetime`) so the migration pattern is proven. Phase 3
migrates the remaining ~18 types and wires the runner's dispatch table.
