# pi-vim

[![CI](https://github.com/neevparikh/pi-vim/actions/workflows/test.yml/badge.svg)](https://github.com/neevparikh/pi-vim/actions/workflows/test.yml)

Vim-style editor extension for pi.

## Install as a pi package (local path)

```bash
pi install ~/repos/pi-vim
```

For project-local install:

```bash
pi install -l ~/repos/pi-vim
```

After installing, reload pi resources with `/reload` (or restart pi).

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
