# Native core (desktop and mobile)

`src/native/` is the shared desktop/mobile core. `src/computer/` and `src/mobile/` build on it.

- `NativeSession` (`session.ts`): Jev targeting via `askSettled`, expect/wait polling, phase timing. Subclasses
  implement `parse`, `label` and `act`.
- `runNativeSpec` (`run-spec.ts`): hooks → open → steps → teardown → close. `nativeCli` (`cli.ts`).
- `src/native/mcp.ts` (`createNativeServer`, `serveNative`) holds the shared step/find/snapshot/ask/read/screenshot/
  save/close tools. Each platform registers its own open and discovery tools first.
- As in the browser: `step` results carry `changed` (diffed against the step's own first whole-screen capture,
  `NativeSession.firstSnapshot`; press/swipe/mouse capture first), picks see `goal` (`open {goal}`, spec `goal:`),
  and `read` answers with tree lines.
- `NativeSession.settled()` uses `askSettled` (`core/automation.ts`): within 1 s of the previous step (or
  `noteActivity()` after open), a platform with `captureEarly` reads a quick tree and Jev works on it while the
  idle-waiting `capture()` runs; the answer is kept only if both frames are identical, else re-asked
  (`ms.reasked`). Android implements it; iOS returns null (no gain measured). The pre-action identity revalidation
  is unchanged.
- Native engines require `--workers 1`.
