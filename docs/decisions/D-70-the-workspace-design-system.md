# D-70 — The workspace's design orientation and system

**Date:** 2026-11-22

**Status:** DECIDED (P-158; built in Run 9.0 Tasks A to H). Evidence: `tests/unit/web/contrast.test.ts`, `tests/browser/a11y.test.ts`, `tests/browser/navigation.test.ts`, `tests/unit/web/sources.test.ts`; the screenshots in `docs/evidence/session-9/screens/`.

## Context

The owner's first visit to the workspace in Session 8 was poor (`docs/evidence/session-8/walkthrough.md`): the navigation did not show where one was, and the project id was only in the address. The owner left the design orientation to the planner.

## Decision

1. **Patterns, not a look.** The workspace takes the _patterns_ of the products its owner would compare it with:
   - Infisical and Doppler for the information architecture: a left sidebar; project, then environment tabs, then the secrets table; ids beside names;
   - Stripe's dashboard for the page contract: a title, one sentence of what the page is for, "How this works" and one primary action; empty states that teach;
   - Linear for keyboard-first navigation (Ctrl K);
   - GitHub Primer for calm, dense, accessible tables and colour tokens.

   No name, logo, illustration, colour set or layout is copied from any of them. MyKey's mark is the word "MyKey" and a key glyph drawn for it.

2. **The system:**
   - **Layout:** a sidebar, a top bar and a bounded content width. Below 64 rem the sidebar is a drawer (`<dialog>`). Wide tables scroll in their frame, and the page never scrolls sideways at 360 px.
   - **Spacing, radii and type:** a 4 px spacing scale, two radii and one soft shadow. The system font stack, since the policy has no `font-src`. Ids are in the monospace stack.
   - **Colour:** tokens on `:root`, with a dark set under `prefers-color-scheme`: a neutral grey scale, one indigo brand hue for actions, links and focus, and the four state tones. Text is at least 4.5:1 on its background, and controls and focus at least 3:1, in both schemes (`contrast.test.ts`).
   - **Icons:** a vendored Lucide subset as inline SVG, with its ISC licence, `aria-hidden` beside text. An icon-only button has an accessible name.
   - **States:** a badge is word, shape and tone. It has a focusable tooltip with the state's meaning from `copy/states.ts`. It is a tooltip rather than a button, because existing tests assert that a row holds no button (P-162).
   - **Motion:** short transitions on hover and the drawer only, and none under `prefers-reduced-motion`.
   - **Theme:** it follows the system. There is no switch, because a switch would need storage, which the page may not have.
3. **Every text comes from one catalogue** (`apps/web/src/copy/`, the help articles), so it can be walked for claims (`docs/evidence/session-9/claims.md`).

## Consequences

- **The workspace's security rules are unchanged** (D-59, D-60): no storage, no `style` attribute, no markup from text. Popovers and tooltips sit in portals, so a row's own text is unchanged.
- **Existing locator names are kept (P-162):** the palette button is "Go to…", not "Search and go to".
- **The bundle grows**, to about 1 MB unminified (255 KB gzip). `apps/web/build.ts` refuses a script above 1.2 MB.
