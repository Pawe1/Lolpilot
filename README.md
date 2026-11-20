# Lolpilot

GitHub Copilot extension for tuning response humor and image frequency.

## Development

The user-level Copilot extension is linked to `extension/` with
`install-dev.ps1`. After changing the extension, reload Copilot extensions from
the app or ask the agent to reload them.

## Local data

Active and saved profiles stay in `profile.md`, `active-profile.txt`, and
`profiles/`. These paths are ignored by Git because they contain user
preferences and response history.

Imported meme images stay in `cache/images/`; `cache/meme-index.json` records
their clues, tags, source, hash, and usage count. The cache is local and ignored
by Git. Existing clue matches can be queried with the `find_meme` canvas action.

## Commands

- `trafione` records a hit and reinforces the style of the rated answer.
- `meh` records a miss and lowers the preference score for that answer's style.
- `humor+` / `humor-` adjust humor directly.
- `humor: stop` switches to fully serious responses.

