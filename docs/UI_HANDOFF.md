# UI handoff: Formula Western pixel theme

**Current release:** Read the [driving and controller handoff](DRIVING_HANDOFF.md) for the live-site comparison, final two-pedal design, route changes, and rollout checks. This page remains the reference for the underlying pixel theme.

This covers the UI work merged on 2026-11-21: the light purple pixel theme, the loading screen, transitions, the Formula Western logo, the phone controller restyle, and faster startup. It also explains how these fit with the pixel 3-2-1-GO countdown and the landmark popups.

## Where things live

| What | File |
|---|---|
| All UI styling: colour tokens, buttons, panels, dialogs, HUD, loader, transitions | `web/ui/components.css` |
| Loading-screen logic, page wipe, change flash, button press effect | `web/ui/components.mjs` |
| Pixel fonts (Press Start 2P, VT323) and their OFL licences | `web/ui/fonts/` |
| Pixel logo, FW mark, favicon | `web/ui/logo-pixel.png`, `web/ui/mark-pixel.png`, `web/ui/favicon.png` |
| Script that regenerates those images from the original logo | `build/pixel_logo.py` (source: `build/assets/formula-western-logo.png`) |
| Phone controller page (inline styles, same theme) | `server/pad.html` |
| Startup preload hints, and copying fonts/logo to `/ui/` for the pad | `vite.config.mjs` |
| Inlining of UI files for the standalone single-file build | `web/build_single.mjs` |

`drive.css`, `lobby/lobby.css` and the inline `<style>` in `index.html` still handle **layout**. `components.css` loads after them and handles the **look**. When you add a new HUD element, put its position in `drive.css` and its colours and fonts in `components.css`.

## Theme tokens

Use these CSS variables (defined on `:root` in `components.css`) rather than hard-coded colours:

| Token | Use |
|---|---|
| `--btn`, `--btn-hover`, `--btn-down` | Light purple button background in its normal, hover and pressed states |
| `--on`, `--on-soft` | Dark purple text on light surfaces (main and secondary) |
| `--lav`, `--lav-solid`, `--lav-2` | Panel surfaces (translucent, solid, inset) |
| `--accent` | Highlights: active toggles, progress, `kbd` keys |
| `--edge` | Dark outline colour |
| `--frame`, `--frame-flat` | Notched pixel border, with and without a drop shadow (`box-shadow` values) |
| `--button-face` | Bevel for buttons |
| `--display` | Press Start 2P: titles, buttons, labels (keep it at 8–16px) |
| `--body` | VT323: body text and numbers (keep it at 16px or larger) |
| `--px` | One "pixel" unit (3px); use it for borders and offsets |

Example of a new themed button:

```css
#my-button {
  font: 10px/1.2 var(--display);
  color: var(--on); background: var(--btn);
  border: 0; border-radius: 0;
  box-shadow: var(--button-face), var(--frame);
}
```

Or just add `class="px-button"` to a button and it picks up the shared style, hover and press states.

## Loading screen

- The markup is `#loader` at the top of `<body>` in `web/index.html`. `#status` (the loading text) now lives **inside** the loader.
- Game code still owns `#status`: it sets the text, sets `hidden` when ready, and sets `role="alert"` on error. `components.mjs` only watches it:
  - text containing "Preparing" moves the bar into its second phase;
  - `hidden` plays the exit animation and then hides the loader;
  - `role="alert"` shows the error state and a Retry button.
- **Do not delete `#loader` or `#status` from the page.** Tests and game code read `#status` after loading. The loader is hidden, never removed.
- The progress bar is real: it counts preload links and finished asset downloads, then creeps through the "Preparing" phase.

## Transitions

- Motion uses stepped timing (`steps(n)`) so it reads as pixel animation. The keyframes are prefixed `px-` in `components.css`.
- HUD panels slide in when `html` gets the `ui-ready` class (added as the loader leaves).
- Links to another mode of the same page (for example `?mode=map`) play a block wipe before navigating. Course or spawn changes and Restart play a checker flash.
- **Animations are switched off** when the user prefers reduced motion, and when `navigator.webdriver` is true (Playwright), via `html[data-ui-instant]`. That keeps screenshot and pixel tests stable. If something must stay visible under reduced motion (like the landmark flash), give it an explicit exception, as at the bottom of `components.css`.

## Countdown and landmark popups

- `#race-countdown` (from the driving updates) still drives the audio cues, the screen-reader announcement and the tests. While the pixel canvas `#pixel-countdown` is showing, the box keeps its size and text but becomes transparent, and the pixel 3-2-1-GO is drawn centred on top. If the pixel canvas is not running, the plain box appears as a fallback.
- `#landmark-flash` uses the pixel display font with a dark outline.

## Dialogs

Time trial (`#trial-setup`), Online (`#online-menu`), Phone pairing (`#phone-pair`) and the mobile menu (`#mobile-drive-menu`) are styled in `components.css`. Their rules start with `:root` because `lobby.css` is loaded later by `online.mjs` and would otherwise win.

## Phone controller (`server/pad.html`)

- The page is served by the worker outside Vite, so it uses **fixed** paths: `/ui/fonts/*.woff2`, `/ui/logo-pixel.png` and `/ui/favicon.png`. The build copies these files there (`padAssets` in `vite.config.mjs`).
- The theme is a block of CSS at the end of its `<style>` that mirrors the main tokens. If you change colours in `components.css`, update the pad block too.
- The QR code on the desktop pairing dialog needs a light background around it to scan; the light lavender dialog provides that.

## Faster loading

The built `index.html` starts every startup download at once instead of in three rounds:

- `modulepreload` links for the drive, scene and scene-pack chunks;
- a small inline script that adds `preload` links for the data JSON files (from the `campus-assets` manifest) and the binary samples needed before the first frame.

This was about 1.1 s faster (6.2 s vs 7.3 s) on a 50 Mbps, 60 ms connection. When you add a new binary asset in `mappedAssets`, pass `true` as the third argument to `unpack()` **only** if it is fetched before the first frame; otherwise Chrome warns about unused preloads. `verify_hosted.mjs` requires the hosted HTML to stay under 20 KB with no `base64,` inside, which is why UI images are never inlined (`assetsInlineLimit` in `vite.config.mjs`).

## Logo

To change the logo, replace `build/assets/formula-western-logo.png` and run:

```sh
.venv/bin/python build/pixel_logo.py
```

This regenerates `logo-pixel.png` (176 px wide), `mark-pixel.png` (the FW mark) and `favicon.png` in `web/ui/`. Display them with `image-rendering: pixelated` at whole-number scales (for example 2× or 3×).

## Rules that keep the tests passing

- Keep button and link names the same (Restart, Online, Phone controller, Drive again, Free roam, Campus map, Gas, Pair controller, and so on). Tests find controls by these names.
- Keep `#status`, `#race-countdown`, `#finish`, `#again` and the other existing IDs.
- `#race-countdown` must stay visible, centred and at least 78 px tall during the countdown (`verify_race_guidance.mjs`).
- On short phone screens the finish panel hides the logo, and the credits toggle hides while the finish screen is open, so "Drive again" stays tappable.

## Known test failures not caused by the UI

- `build/check_building_preview.py`: needs `data/streetview/frames.json`, which `.gitignore` excludes.
- The WebKit (iPhone) parts of `verify_trial_phone.mjs`, `verify-pad.mjs` and `verify_race_engines.mjs`: need `npx playwright install webkit`.
- `verify_look.mjs`: requires 57 fps; slower machines fail it on `main` as well.
