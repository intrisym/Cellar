# Cellar

Cellar is a macOS Homebrew GUI prototype. It uses the official Homebrew Formulae API for catalog metadata and, when run as the desktop app, uses a restricted Electron bridge to run Homebrew install, uninstall, upgrade, and diagnostic commands.

## User Features

- Browse Homebrew formulae and casks with clear labels for non-technical users.
- Install and remove individual packages through guarded Homebrew actions.
- Manage installed packages and available updates together in Library.
- Bulk update all outdated Homebrew packages with one `Update All` action.
- Run a Homebrew checkup without opening Terminal.

## Run Locally

```sh
npm install
npm start
```

Opening `index.html` directly still works as a read-only catalog browser, but package installation and removal require the Electron desktop app.

## Homebrew Cask Distribution

The intended user install flow is:

```sh
brew install --cask cellar
```

A release build should publish a signed and notarized macOS `.dmg` or `.zip`. The Homebrew cask would then point at that release artifact.

Example cask shape:

```ruby
cask "cellar" do
  version "0.1.0"
  sha256 "REPLACE_WITH_RELEASE_SHA256"

  url "https://github.com/YOUR_ORG/cellar/releases/download/v#{version}/Cellar-#{version}-mac.zip"
  name "Cellar"
  desc "Friendly macOS GUI for Homebrew formulae and casks"
  homepage "https://github.com/YOUR_ORG/cellar"

  app "Cellar.app"
end
```

## Safety Model

Cellar does not run arbitrary shell commands. The desktop bridge accepts only known Homebrew operations and validates package tokens before running `brew`. Bulk update uses Homebrew's standard `brew upgrade` command.
