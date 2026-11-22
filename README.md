free for anyone's use, feel free to clone, duplicate.

Feel free to play around.

# Drive Western

A browser driving game recreating Western University's campus in London, Ontario. The front end uses Three.js r170 and Vite 8 (`web/`), the asset pipeline is written in Python (`build/`), and multiplayer/phone relay runs on Cloudflare Workers and Durable Objects (`server/`).

[![A car approaches the campus roundabout on Lambton Drive and follows the island counterclockwise](docs/roundabout.webp)](docs/roundabout.mp4)

[Watch the 10-second gameplay clip (MP4)](docs/roundabout.mp4).

Terrain is built from lidar elevation data. Roads, paths, and building outlines come from OpenStreetMap and City of London open data, using 2025 orthophotos and KartaView street-level photos as references. Each campus building is defined by a per-building JSON spec (`build/specs/buildings/*.json`, schema `build/specs/building-spec-v1.schema.json`), compiled by `build/compile_buildings.py`, and generated in the browser by `web/building-*.mjs`.

See the [release handoff and live-site comparison](docs/DRIVING_HANDOFF.md) for the UI differences, controls, route changes, and deployment checks.

## Requirements & Setup

- Node.js 22+ (developed on Node 26) and npm 10+
- Python 3.12+ (3.12 and 3.14 tested)
- Tested on macOS

```sh
npm run setup
```

This runs `npm ci` and creates `.venv` with `build/requirements.txt`. The Python environment is required because the web build invokes `.venv/bin/python`.

## Running Locally

```sh
npm start
```

Builds and serves the game along with the local Cloudflare Worker via Wrangler (no Cloudflare account required). It prints a Desktop URL and a LAN Phone URL on port 4173.

For front-end work without multiplayer or phone relay:

```sh
npm run dev
```

**Controls:** Arrow keys or WASD to drive, Space to drift, `R` to restart. Choose **Free roam → Start near → Roundabout approach** to practise the entrance. On a circuit or the sprint, driving assists ease the throttle and brake before tight bends; the HUD shows **Bend assist** when active.

## Phone Controller

1. On desktop, click **Phone controller**.
2. On a phone connected to the same Wi-Fi, scan the QR code or open `/pad` and enter the 6-character code.
3. Tap **Start driving**, allow motion access, and hold your phone sideways. Rotate it clockwise to steer right or counterclockwise to steer left; bring it level to straighten.
4. While turning at speed, **double-tap Brake to drift**. Keep your other thumb on Gas to maintain throttle. A single press brakes normally; holding Brake at a stop reverses. The Brake pedal flashes gold during the handbrake pulse. There is no separate Drift button.

Hold the controller sideways; it also supports portrait orientation lock with a rotated layout. Over plain LAN HTTP, use the steering arrows. Wheel steering requires a secure context and motion permission. On networks with client isolation (such as schools), use the deployed site instead of LAN mode.

## Multiplayer

Rooms support up to 8 players via a 6-character code or invite link. Each client simulates its own car and sends 64-byte state updates at 60 Hz over WebRTC data channels, with a WebSocket fallback through the Worker. Remote cars are extrapolated to the present with error-decay smoothing.

Rooms handle lobby state, ready checks, synced countdowns, race results, reconnects (seats are held for ~20 s), and graceful draining on deploy. Netcode lives in `web/net/`; room logic is in `server/room.mjs`.

## Deployment & Cost

Log in once, then deploy:

```sh
npx wrangler login
npm run deploy
```

This publishes to `https://drive-western.<your-subdomain>.workers.dev`.

- **Multiplayer:** Enabled in the checked-in Worker configuration (`MULTIPLAYER: "1"`).
- **Optional TURN relay (TLS 443):** Set `TURN_URL` (e.g. `turns:relay.example:443?transport=tcp`) along with `TURN_SECRET` (coturn shared secret), or `TURN_USER` and `TURN_PASSWORD`.
- **Custom domain:** Add `"routes": [{"pattern":"drive.example.org","custom_domain":true}]` to `server/wrangler.jsonc`.

**Cost estimate (Cloudflare Workers Paid plan, $5/month minimum):** Durable Object incoming WebSocket messages are billed 20:1 at $0.15/M requests and duration at $12.50/M GB-s (1M requests and 400k GB-s included). One full 8-player room costs about $0.02/hour; 8 full rooms for 3 hours/day is about $14/month; 8 full rooms 24/7 is about $107/month. The free plan's request allowance runs out after roughly one hour of a single full room.

## Building Workflow

Edit a building spec in `build/specs/buildings/<id>.json`, then validate, preview, compile, and verify:

```sh
.venv/bin/python build/validate_specs.py <id>
node web/dev/building_preview.mjs --id <id> --out <dir>
.venv/bin/python build/compile_buildings.py
node web/dev/verify_campus_buildings.mjs
```

`verify_campus_buildings.mjs` enforces LOD triangle budgets: far <120k, mid <850k, near <4.4M.

## Testing & Checks

Project checks are defined in `.agent/agentkit.toml` under `fast` and `full`:

```sh
agentkit verify   # fast checks
npm run verify    # full checks
```

Individual commands from `.agent/agentkit.toml` can also be run directly. Some full checks render building previews under a 20-second render limit and need a quiet machine.

Netcode and server verification:

```sh
node server/test-net.mjs                # unit tests
node server/bench-net.mjs               # full netcode bench (or --quick)
node server/bots.mjs --seconds 140      # load test
node server/verify-online.mjs           # browser journey: online multiplayer
node server/verify-pad.mjs              # browser journey: phone controller
node server/verify-school.mjs           # browser journey: restricted network
```

## Repository Layout

- `web/` — game client, compiled assets, and dev tools (`web/dev/`)
- `web/net/` — shared netcode
- `web/race/` — deterministic simulation, courses, replays
- `web/lobby/` — room UI and phone pairing
- `server/` — Cloudflare Worker, rooms, relay, tests, benchmarks
- `build/` — Python data pipeline, building specs, validation checks
- `data/` — build inputs
- `.agent/agentkit.toml` — saved check lists

## Excluded Data

About 40 GB of raw/intermediate files are omitted from the repository: `data/streetview` (KartaView photos), `data/audit` (per-cell audit renders), `data/buildings/review`, the raw lidar tiles in `data/buildings/lidar`, and most of `data/buildings/evidence`.

Compiled assets in `web/` and the inputs required to rebuild them (`data/region`, `data/models`, `data/street`, `data/lidar`, `data/buildings/inventory.json`, `data/buildings/lidar/roof-grid.npz`, and each building's `aerial-source.jpg`) are included, so the game builds and runs from a fresh clone.

To regenerate raw inputs:

```sh
.venv/bin/python build/fetch.py                 # OSM and imagery tiles
.venv/bin/python build/streetview_frames.py     # KartaView frames
.venv/bin/python build/building_inventory.py    # inventory.json and per-building evidence
node web/dev/audit/run.mjs --run <name> --stage all --workers 4  # per-cell audit renders
```

## Data Credits

- OpenStreetMap contributors (ODbL)
- City of London open data
- KartaView imagery (CC BY-SA)
- Western University facilities references

Check each source's license before redistributing derived data or assets.
