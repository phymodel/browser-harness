# browser-harness

A **self-contained browser harness with its own Chromium window** — no permission over the device browser,
no extension, no shared profile. Perception is accessibility-tree first (`[ref=eN]` handles), screenshots are
on demand and only for human verification. Control surface: a resident local daemon + one CLI (`browserctl`).

```bash
sh scripts/setup.sh                       # check node/playwright/chromium
sh scripts/smoke.sh                       # isolated end-to-end self-test (28 assertions)

sh scripts/browserctl start https://example.com
sh scripts/browserctl snapshot                    # a11y tree + stable refs (the main perception call)
sh scripts/browserctl type e12 "hello" --submit
sh scripts/browserctl logs --errors
sh scripts/browserctl screenshot --full           # PNG on disk, for humans
sh scripts/browserctl stop
```

- **Built-in, not device** — the harness launches and owns its own Chromium (dedicated `user-data-dir` in
  `.profile/chromium`). Nothing of the device's browser, extensions, settings or logins is touched, and no OS
  automation permission is needed. Cost: one-time Chromium build in the shared Playwright cache.
- **Ref-based, not pixel-based** — the agent reads a compact accessibility tree (`- button "提交" [ref=e8]`) and acts
  on refs; Playwright performs the real input with actionability waiting. Refs inside iframes look like `f1e2`.
- **Fails closed** — after a navigation or DOM change an old ref returns `E_STALE_REF` with a fix hint instead of
  silently clicking something else.
- **Auditable** — console logs, page errors, dialogs, network requests, downloads and screenshots all land in `.state/`.
- **Zero runtime dependencies** — Node ≥ 22.6 runs the TypeScript directly; `playwright` is resolved from a local
  install, `npm root -g`, or `$BH_PLAYWRIGHT`.

Full docs: [HARNESS.md](./HARNESS.md) · [references/](./references/)

```
src/cli.ts       browserctl (RPC client + human/machine output)
src/daemon.ts    resident daemon: window lifecycle, HTTP JSON-RPC on 127.0.0.1, token auth
src/session.ts   every command: snapshot/find/act/tabs/telemetry/window
src/pw.ts        playwright resolution
scripts/         setup · smoke · browserctl · daemon
```

## License

MIT — see [LICENSE](./LICENSE).

## Acceptable use & disclaimer

browser-harness is a **general-purpose browser automation harness**. It drives its own Chromium
instance and is **not** a scraping-evasion, anti-bot or fingerprint-spoofing tool.

- **No anti-detection features, by design.** The harness does not spoof fingerprints, solve or
  bypass CAPTCHAs, or circumvent access controls. Such features will not be added — see
  "边界与非目标 / Non-goals" in [HARNESS.md](./HARNESS.md).
- **You are responsible for how you use it.** Automated access may be restricted by the terms of
  service of the sites you visit, by `robots.txt`, or by law. Comply with them. Do not use this
  project to access accounts or data you are not authorised to access, to attack or overload a
  service, or for any unlawful purpose.
- **No warranty.** Provided "AS IS", without warranty of any kind; the authors are not liable for
  any damage or loss arising from its use.
- **Not affiliated** with any website, service or vendor; product names and trademarks mentioned
  in the documentation belong to their respective owners.
