# Redesign brief

Repo: `~/date-genie`. Live: https://date-genie.agent9.dev
Safe point: `git reset --hard working-2026-09-04` restores a verified build.

## The product, in one line

Say one sentence and get one bookable evening: dinner, something afterwards, and
somewhere to leave the car. The page is also a WebMCP surface, so a browser
agent drives the identical tools a human clicks.

## Touch only these three files

```
src/styles.css                          design tokens, 272 lines
src/components/date-genie/panels.tsx    all panels, 976 lines
src/routes/index.tsx                    page layout, 178 lines
```

## Do not modify anything else

Everything under `src/lib/` and `src/api.ts` is planning logic, the source
adapters, and the WebMCP tool surface. Around 5,000 lines, all of it verified
working and none of it presentational. Changing it breaks the submission.

Specifically, do not rename or remove:

- any export from `panels.tsx`: `useGenie`, `StatusPill`, `CommandBar`,
  `ConstraintDeck`, `Stage`, `ApprovalSheet`, `ToolConsole`, `ToolSurface`,
  `SourcesPanel`
- the accessible names of two buttons, which automated tests select by text:
  **"Plan it"** and **"Confirm and book it"**
- `role="dialog"` on the approval sheet
- any `callTool(...)` or `store.*` call

## What the design has to carry

1. **The evening is the hero.** Three legs in time order with times, venue names,
   and per-leg cost. This is the only thing on the page allowed to be loud.
2. **The approval sheet is the emotional peak.** A tool call is genuinely
   suspended while it is open, waiting on a human. It should feel like a decision,
   not a toast.
3. **The constraint receipt must stay scannable.** Target versus actual for every
   rule the user set. It is the proof the plan is honest.
4. **The agent console must stay legible but quiet.** It shows every tool call
   live. It should never compete with the evening.
5. **Provenance is a feature, not fine print.** The page states which numbers are
   real (names, locations, ratings, prices) and which are simulated (table times,
   showtimes). Do not hide this.

## Current direction, which you may replace entirely

Blue hour: a twilight-blue ground with real chroma, Instrument Serif for times
and venue names, monospace confined to the console, amber rationed to money and
the one button that spends it. If you take it somewhere better, take it.

Two things to avoid because they are what it looked like before and it was bad:
equal-weight panel grids where everything competes, and all-caps tracked labels
above every section.

## Verify before you finish

```sh
npm run typecheck     # must pass
npm run lint          # 0 errors (8 pre-existing shadcn warnings are fine)
npm run build
npm run deploy        # typechecks first, refuses if it fails
npm run e2e           # must print: FORGED_TOKEN_RESULT: THREW: No such tool
                      # then BOOKING: GENIE-xxxxx, and CONSOLE_ERRORS: none
```

If `npm run e2e` does not print those three lines, the redesign broke something
load-bearing. Revert and try again.

## Responsive and accessibility floor

Works to 390px wide. Visible keyboard focus. `prefers-reduced-motion` respected
(the existing utilities already do this). Text contrast holds on the chosen
ground.
