# Cellar

Cellar is a macOS Homebrew GUI prototype. It uses the official Homebrew Formulae API for catalog metadata and, when run as the desktop app, uses a restricted Electron bridge to run Homebrew install, uninstall, upgrade, and diagnostic commands.

## User Features

- Browse Homebrew formulae and casks
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

## Build Release Zip

Create the macOS release zip with:

```sh
npm run dist
```

The unsigned local build is written to:

```text
dist/Cellar-0.1.0-mac.zip
```

This artifact is ignored by git and should be uploaded to a GitHub Release before publishing a Homebrew cask.

## GitHub Pages Preview

The static browser preview can be deployed with GitHub Pages at:

```text
https://intrisym.github.io/Cellar/
```

The Pages preview supports browsing, searching, and filtering Homebrew catalog data. Installing, removing, updating, and Homebrew diagnostics require the Electron desktop app because those actions need the local Homebrew bridge.

## Homebrew Cask Distribution

The intended first-party tap install flow is:

```sh
brew tap intrisym/cellar
brew install --cask cellar
```

A release build should publish a signed and notarized macOS `.zip` containing `Cellar.app`. The Homebrew cask points at that release artifact.

The committed cask template is stored at:

```text
Casks/c/cellar.rb.template
```

Generate the local cask file from the template, then replace `REPLACE_WITH_RELEASE_SHA256` with the SHA-256 of the release zip:

```sh
cp Casks/c/cellar.rb.template Casks/c/cellar.rb
shasum -a 256 dist/Cellar-0.1.0-mac.zip
```

`Casks/c/cellar.rb` is ignored by git so an invalid cask with a placeholder checksum is not committed accidentally.

Current cask shape:

```ruby
cask "cellar" do
  version "0.1.0"
  sha256 "REPLACE_WITH_RELEASE_SHA256"

  url "https://github.com/intrisym/Cellar/releases/download/v#{version}/Cellar-#{version}-mac.zip"
  name "Cellar"
  desc "Friendly macOS GUI for Homebrew formulae and casks"
  homepage "https://github.com/intrisym/Cellar"

  app "Cellar.app"
end
```

To test the cask locally after replacing the checksum:

```sh
brew install --cask ./Casks/c/cellar.rb
brew uninstall --cask cellar
brew audit --new --cask ./Casks/c/cellar.rb
```

For a dedicated tap repository, create `github.com/intrisym/homebrew-cellar`, copy `Casks/c/cellar.rb` into it, then users can run:

```sh
brew tap intrisym/cellar
brew install --cask cellar
```

## Safety Model

Cellar does not run arbitrary shell commands. The desktop bridge accepts only known Homebrew operations and validates package tokens before running `brew`. Bulk update uses Homebrew's standard `brew upgrade` command.
