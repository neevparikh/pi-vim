# pi-vim

[![CI](https://github.com/neevparikh/pi-vim/actions/workflows/test.yml/badge.svg)](https://github.com/neevparikh/pi-vim/actions/workflows/test.yml)

Vim-style editor extension for pi.

## Optional integrations

### pi-cas-provider fast-mode badge

If [pi-cas-provider](https://github.com/neevparikh/pi-cas-provider) is also
loaded, pi-vim subscribes to its `pi-cas:fast-mode` event and paints a `⚡`
glyph next to the mode label in the editor's top border:

- bright = fast mode engaged on the last turn (premium billing)
- muted  = requested, no turn yet
- dim    = requested but API refused (no premium charge)
- red    = cooldown / pool depleted

There is no hard dependency — if pi-cas-provider isn't installed, the event
never fires and the badge never appears. Any other extension that emits the
same `pi-cas:fast-mode` channel with the same payload shape will drive the
badge identically.

## Install as a pi package (local path)

```bash
pi install ~/repos/pi-vim
```

For project-local install:

```bash
pi install -l ~/repos/pi-vim
```

After installing, reload pi resources with `/reload` (or restart pi).

## Optional integrations

### pi-cas-provider fast-mode badge

If [pi-cas-provider](https://github.com/neevparikh/pi-cas-provider) is also
installed, pi-vim renders a `⚡` glyph next to the mode label whenever fast
mode is requested. The glyph dims when the API doesn't actually engage fast
mode and turns red on cooldown, mirroring pi-cas-provider's own footer badge.

The integration is purely event-bus driven (channel `pi-cas:fast-mode`) — no
hard dependency. If pi-cas-provider isn't loaded, no event fires and no glyph
is rendered.

## Development

Install dev dependencies:

```bash
npm install
```

Run tests:

```bash
npm run test
```

## Package manifest

This repo is a pi package via `package.json`:

- `pi.extensions`: `./src/index.ts`

The extension entrypoint is:

- `src/index.ts`
