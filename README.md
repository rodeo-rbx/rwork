# rwork

A CLI for fully managed Rojo workflows — build, sync, and publish Roblox places from one config.

rwork drives [Rojo](https://github.com/rojo-rbx/rojo) and [darklua](https://github.com/seaofvoices/darklua) through builds defined in `rwork.toml`, and opens/publishes places via [rodeo](https://github.com/revvy02/rodeo). It expects `rojo` and `rodeo` on your PATH.

## Install

```sh
rokit add revvy02/rwork
# or
mise use ubi:revvy02/rwork
```

Or download a prebuilt binary from [Releases](https://github.com/revvy02/rwork/releases).

## Configure

Define named builds in `rwork.toml`. Each build picks a Rojo project, source dir, darklua config, and build-time globals:

`src` is the darklua-compiled root — the tree that gets require conversion,
global injection, and the asset/sourcemap watchers. It's optional: omit it for a
build whose project serves every `$path` raw (native string requires, no
compile step), and `build`/`sync` skip the darklua pipeline entirely — sync
becomes just the staged project + `rojo serve`.

```toml
[build.dev]
project = "default.project.json"
src = "src"
darklua = ".darklua/dev.darklua.json"

[build.dev.globals]
__DEV_TOOLS__ = true

[build.prod]
project = "default.project.json"
src = "src"
darklua = ".darklua/prod.darklua.json"

[build.prod.globals]
__DEV_TOOLS__ = false
```

Select one with `--build <name>` (default `dev`).

### Named places

Declare shared deploy targets in a `[places]` section, optionally binding each to
a build:

```toml
[places.staging]
id = 1234567890
build = "prod"

[places.prod]
id = 9876543210
build = "minify"
```

`--place` accepts a `[places.*]` name or a raw place id, resolved the same way in
every command. Targeting a named place makes its bound build the default, and an
explicit `--build` that contradicts the binding is an error — so a dev build
can't accidentally ship to a prod-bound place:

```sh
rwork publish --place staging               # prod build → place 1234567890
rwork publish --place staging --build dev   # error: conflicts with bound build "prod"
```

`RWORK_PLACE_ID` stays the per-developer scratch target: point it at your own
place and any build publishes there without flags (it resolves through the same
rule, so it may also hold a place name).

## Commands

```sh
rwork build [--open]    # compile + build → .rwork/<build>/build.rbxl
rwork sync              # live-sync source into an open Studio (rojo serve + watchers)
rwork dev               # build + open + sync — the local iteration loop
rwork publish --place <id>   # build + upload to a live place
```

`--open` opens the result in Studio: the built file for `build`, the live place for `publish`.

### Build stamp

Every command stamps two attributes on `ReplicatedStorage` so a place can be
traced back to what it was built from:

- `RWORK_BUILD` — the `[build.*]` name the place was built with, e.g. `dev` or `prod`
- `RWORK_REVISION` — the git revision as `branch@commit`, with `-dirty` appended
  when there were uncommitted changes

Read them in game from `ReplicatedStorage`:

```luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")

print(ReplicatedStorage:GetAttribute("RWORK_BUILD"))     --> "prod"
print(ReplicatedStorage:GetAttribute("RWORK_REVISION"))  --> "main@3f2a9c1e0b7d4a55c8e2f1a9b6d0c3e7f4a1b2c9"
-- a local build with uncommitted changes:              --> "feature/stamp@1cdb0bd5...-dirty"
```

During sync the stamp is taken once at startup; restart sync to refresh it.

### Live places

Pass `--place <id|name>` (or set `RWORK_PLACE_ID`) to work against a real Roblox place instead of a local file:

```sh
rwork dev --place <id|name>              # open the published place + sync into it
rwork dev --place <id|name> --upload     # publish a fresh build + open + sync
rwork publish --place <id|name> --open   # publish and open, no sync loop
```

## Environment

- `RWORK_PLACE_ID` — default live place (a raw id or a `[places.*]` name); meant as each dev's personal scratch place
- `RWORK_API_KEY` — Open Cloud key for publishing (place-publishing scope)
- `RWORK_UNIVERSE_ID` — override the auto-resolved universe id when publishing
- `RWORK_REVISION` — override the stamped revision (see Build stamp); by default it comes from `GITHUB_SHA`/`GITHUB_REF_NAME` on GitHub Actions, otherwise from `git`
- `RWORK_DIAG=1` — verbose diagnostic logging
- `RWORK_INCLUDE_ASSETS_WHEN_SYNCING` / `RWORK_INCLUDE_SERVER_STORAGE_WHEN_SYNCING` — set `false` to exclude during sync
- `RWORK_SYNC_PORT` — port for `rojo serve` during sync (rojo's default when unset). Sync also auto-restarts rojo if it crashes (repeated immediate crashes give up).

## License

[MIT](LICENSE)
