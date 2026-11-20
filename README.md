# Lolpilot

Personal GitHub Copilot extension for tuning response humor and image frequency.

## Development

The user-level Copilot extension is linked to `extension/` with
`install-dev.ps1`. After changing the extension, reload Copilot extensions from
the app or ask the agent to reload them.

## Local data

Active and saved profiles stay in `profile.md`, `active-profile.txt`, and
`profiles/`. These paths are ignored by Git because they contain personal
preferences and response history.

## Commands

- `trafione` increases humor and records a hit.
- `meh` lowers humor and records a miss.
- `humor+` / `humor-` adjust humor directly.
- `humor: stop` switches to fully serious responses.

