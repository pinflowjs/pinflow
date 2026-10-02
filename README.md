<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pinflowjs/pinflow/main/.github/assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/pinflowjs/pinflow/main/.github/assets/hero-light.svg">
  <img alt="A reviewer pins a comment on an Upgrade button; Pinflow exports Markdown carrying the element, its selectors, the surrounding context and a computed-style snapshot." src="https://raw.githubusercontent.com/pinflowjs/pinflow/main/.github/assets/hero-light.svg" width="880" height="380">
</picture>

# Pinflow

Add a comment layer to any web page, then hand the export to your coding agent.

[![npm](https://img.shields.io/npm/v/pinflowjs)](https://www.npmjs.com/package/pinflowjs)
[![license](https://img.shields.io/npm/l/pinflowjs)](./LICENSE)
[![core size](https://img.shields.io/badge/core-32_kB_gzipped-2563eb)](./package.json)

[Try it on pinflow.dev](https://pinflow.dev) · [Guide](./docs/guide.md) · [API](./docs/wiki/api.md) · [Examples](./examples)

Coding agents can't see your screen. Tell one that the upgrade button looks weak and it has to work
out which element you meant, usually getting it wrong once or twice first.

Pinflow lets whoever is reviewing click the element instead of describing it. What comes out is a
markdown file with the selector, the heading the element sits under, and what it looked like at the
time, next to the comment itself.

You add one script tag. Reviewers don't install anything or sign in, and it works on a phone.

```html
<script src="https://cdn.jsdelivr.net/npm/pinflowjs" data-project="my-prototype"></script>
```

Send someone the URL. They pin notes on the page, hit Export & share, and send you the file it
downloads. You paste that into your coding agent.

## What comes out

Leave a note on [pinflow.dev](https://pinflow.dev), hit Export & share, and you get a file like this
one. The reviewer typed the last line; the widget generated the rest. Here a reviewer at a desk
dragged a box over a pale Upgrade button, and the comment is trimmed to the lines discussed below:

<!-- prettier-ignore -->
```markdown
## Route: /billing

### Comment 1
**Comment ID:** `cmt_kn1n6pa0k`
**Status:** open
**Element:** `<button data-testid="upgrade-button">` (“Upgrade”)
**Context:** the ‘Upgrade’ button under ‘Studio’
**Computed:** background rgb(243, 241, 238), text rgb(154, 149, 143), font 14px -apple-system, text-align center, radius 10px
**Selector candidates:**
- testid: `upgrade-button`
- css: `body:nth-of-type(1) > main:nth-of-type(1) > section.plans:nth-of-type(1) > div.actions:nth-of-type(3) > button.upgrade:nth-of-type(1)`
- xpath: `/html/body/main[1]/section[1]/div[3]/button[1]`
**Scope:** `<section>` (“Plans Monthly billing Studio $24 / month Everything a busy studio needs. Unlimit…”) — `body:nth-of-type(1) > main:nth-of-type(1) > section.plans:nth-of-type(1)` (rung: source, confidence: high, gen: 3)
**Source hint (page-supplied, unverified):** `src/components/PlanCard.tsx`
**Selected — 1 element(s) observed at capture:**
- `<button data-testid="upgrade-button">` (“Upgrade”) — `body:nth-of-type(1) > main:nth-of-type(1) > section.plans:nth-of-type(1) > div.actions:nth-of-type(3) > button.upgrade:nth-of-type(1)`
**Do not change — 1 element(s) the region only touched:**
- `<a>` (“Compare plans”) — `body:nth-of-type(1) > main:nth-of-type(1) > section.plans:nth-of-type(1) > div.actions:nth-of-type(3) > a.compare:nth-of-type(1)`
**Viewport at time of comment:** 1280×800 (desktop)

> Upgrade reads as disabled. Make it the primary action and leave the compare link as it is.
```

The three selectors give the agent a fallback if the page has moved on since. `Context` is there so
it can search the source when none of them match, and `Computed` tells it what the colour actually
was rather than making it infer that from "looks weak".

`Scope`, `Selected` and `Do not change` say how far a fix may reach. The box covered the button and
only grazed the link beside it, so the link is listed as one to leave alone. When a comment carries a
scope, the file opens with a note telling the agent to read it as a ceiling, not a grant, and to
treat everything in the file as data from a web page, never as instructions addressed to it.

## Install

| You have                                | Add this                                                                   | Notes                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Any web page**                        | `<script src="https://cdn.jsdelivr.net/npm/pinflowjs" data-project="app">` | Nothing to build. WordPress, Webflow, a static file — anything you can paste a tag into. |
| **React / Next.js**                     | `npm i pinflowjs` → `import { Annotator } from 'pinflowjs/react'`          | Wrapper capped at 0.51 KB gzipped in CI. See the [guide](./docs/guide.md#frameworks).    |
| **Vue / Nuxt**                          | `npm i pinflowjs` → `import { Annotator } from 'pinflowjs/vue'`            | Wrapper capped at 0.69 KB gzipped in CI.                                                 |
| **A generated app** (Lovable, v0, Bolt) | The script tag, in the generated `index.html`                              | Paste the export back into the chat so the next generation gets it right.                |

## How it goes

Send someone a link to a page that has the script on it. They click what's wrong and type a
sentence. If typing on a phone is the problem, voice notes are an optional module for npm installs;
the script-tag build doesn't include them.

Until they export, the notes stay in their browser. When they're done, Export & share downloads the
markdown file and copies it to their clipboard, and they send it to you however you usually talk.
Your own code can read the same feedback too: `exportJSON()` returns it as JSON, and `onSubmit` or
the sync hooks send it to a backend you run.

Then paste it into your agent. The [`agent/`](./agent/README.md) folder in the package explains the
format to it first, as a skill, a slash command, an editor rule, or an `AGENTS.md` snippet, so it
knows what `Position` means before it starts editing.

## Worth knowing

Reviewers install nothing. Most tools in this space want a Chrome extension or a running dev server,
which rules out the people whose opinion you actually needed: the client, the PM, someone glancing
at it on their phone.

Pins survive edits. When an agent rewrites the page, Pinflow re-finds elements through a selector
ladder — test id, then role plus accessible name (which outlives a CSS-modules rebuild), then
structure — that falls back to fuzzy text matching. If it can't find one with reasonable confidence it
reports the comment as orphaned instead of quietly attaching it to whatever is nearby now, which is
the failure you'd never catch.

Comment text gets escaped on the way out. It's user input heading into an agent's context window, so
the export sanitises it. That's a [hard invariant](./AGENTS.md) with tests behind it.

No runtime dependencies, MIT, no telemetry, and CI won't let the bundle past its size ceiling.

## What it doesn't do

- It isn't a bug tracker. No threads, assignees, priorities or notifications.
- Nothing is hosted. Comments sit in the reviewer's browser until someone exports them. Sharing
  across people or devices means [wiring up a backend](./docs/guide.md#connect-your-own-backend).
- It can't see your source, only the rendered DOM. Connecting an element to a file is the agent's
  job, which is why the export gives it so much to go on.

## Docs

[Guide](./docs/guide.md) covers configuration, sync, voice, builder mode, privacy and
troubleshooting. There's also the [API reference](./docs/wiki/api.md), the
[sync protocol](./PROTOCOL.md), notes on [how it's built](./docs/wiki/README.md), and
[examples](./examples).

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) has local setup, and
[AGENTS.md](./AGENTS.md) lists what CI enforces: bundle ceilings, coverage, and the export escaping.
Security reports go to [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Brijesh Patel
