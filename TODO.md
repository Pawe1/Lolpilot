# TODO

## Publish matched memes inline

Track: [github/app#6018](https://github.com/github/app/issues/6018)

The host currently cannot publish an extension-owned local image inside an
assistant response. `sendAttachmentsToMessage` adds an input attachment to the
model turn, and localhost Markdown URLs are not rendered, so Lolpilot keeps
automatic image output disabled.

When the host implements extension-owned response assets:

- [ ] Verify the installed SDK exposes an assistant-response image/block API.
- [ ] Replace the disabled image-output branch in `extension/extension.mjs`.
- [ ] Pass the matched meme as a local/session-scoped file or blob, never as a
  localhost URL or large base64 transcript payload.
- [ ] Require alt text and keep the source/template metadata visible to the host.
- [ ] Add a focused test proving the image appears inline after a matching prompt.
- [ ] Keep `Images: Never` and censor-safe mode authoritative.
- [ ] Remove the temporary instruction that forbids image publishing only after
  the new path is verified end to end.

The current meme index, template analysis, search, duplicate handling, and
manual Canvas library remain available while output is disabled.
