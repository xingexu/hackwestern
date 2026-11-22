# Formula Western | Driving release handoff

**For the maintainer of [fwestern.ca](https://fwestern.ca/).** The final phone layout has two pedals: **Gas** and **Brake**. Hold the phone sideways and rotate it like a wheel. Press Brake once to slow down, hold at a stop to reverse, or double-tap it while turning at speed to start a slide. Gas never triggers a drift. [Gameplay clip](roundabout.mp4) · [Pixel theme reference](UI_HANDOFF.md)

For a physical phone on a development machine, follow the [local HTTP drift test and trusted HTTPS wheel setup](../README.md#test-on-your-phone). The [theme specification](../README.md#theme-and-loading-screen) records exact colours and transition timings.

## Which builds are being compared?

The **live** column is a snapshot of `/`, `/pad`, `/api/health`, and the published driving bundle and route assets fetched from fwestern.ca on **November 21, 2026 (Toronto)**. The **release** column describes this repository build. Live reported multiplayer protocol 2, rules 2, simulation `0x81013879`; the release simulation is `0xc87be8ac`. The live pad HTML matched the earlier controller in git, but those observations do not identify the deployment's exact commit. A merge on GitHub does **not** establish which build the domain serves.

| Player-facing area | Live at inspection | Release |
|---|---|---|
| Visual design and startup | Desktop course card with a plain W; system-font phone buttons and a text loading status. | Formula Western pixel logo, lavender beveled panels, pixel fonts, progress loader, page wipes, course-change flash, restyled dialogs and finish screen. Font/asset preloads reduce startup round trips. The theme predates this driving change on main. |
| Countdown and landmarks | Text countdown; published driving bundle lacked the pixel-countdown and landmark-flash components. | Animated 3–2–1–GO layered over the existing accessible countdown, with nearby landmark names. Reduced motion keeps the information without the transitions. |
| Dashboard | Speed, gear/RPM, run time, road/surface and progress. | Adds a segmented RPM strip with a shift colour above 6,000 RPM. A traction badge distinguishes **Grip**, **Slide entry**, **Drift N°** (actual sideslip) and **Bend assist**. The phone HUD keeps compact versions. |
| Paired controller | Brake/reverse and Gas; arrows or motion steering with a small wheel icon. Packets carried steering, throttle and brake only. | Still two pedals. Brake says **Double-tap to drift** and briefly turns gold and reads **Drift** during the pulse. Wheel mode has a larger rotating rim and Straight/Left/Right angle readout. Arrow fallback, sensitivity, pairing and reconnect remain. No separate Drift paddle or Gas-swipe shortcut. |
| Other inputs | On-device touch Gas and Brake; no double-tap gesture in the live pad. | Direct-touch Brake uses the same recognizer and flashes gold. Desktop keeps WASD/arrows plus Space; gamepad uses stick/RT/LT plus A (button 0). Driving hints follow the input type. |
| Navigation | Minimap and checkpoint directions, with no roundabout practice spawn or named roundabout feedback found in the published drive bundle. | Lane-following arrows start just ahead of the car; the HUD points toward the upcoming line, with remaining distance along the route. Minimap arrows mark roundabout circulation. **Free roam → Start near → Roundabout approach** starts about 40 m before entry. |
| Road feedback | Published bundle lacked the new traffic warnings. | Non-sprint HUD names the roundabout and prompts **keep the island on your left**. **Wrong way**, **Keep right** and **Restricted road** are warnings, not collisions or penalties. The car can still explore in free roam. |
| Handling and grid | Steering assistance, grip physics and starting slots already existed. | Digital steering eases near the target. On the sprint/circuits, enabled assists ease throttle and apply gentle braking before sharp bends. Deliberate handbrake input reduces rear grip; countersteering and releasing the brake help catch the slide. Online circuit grid slots follow the lane at roughly 5 m intervals rather than straddling the centre line. |

## Course model

Approximate horizontal lengths from the served and generated route samples; these are not official surveyed race distances.

| Course | Live | Release | What changed |
|---|---:|---:|---|
| UC Hill Sprint | 646 m | 562 m | Finishes on Elgin; drops the Oxford/Kent tail. |
| College Hill | 1,532 m | 2,034 m | Replaces the restricted Oxford connection with Western Road; circulates counterclockwise. |
| Stadium | 1,537 m | 1,526 m | Same named roads; new lane path and roundabout entry/exit. |
| Main Campus | 2,484 m | 2,682 m | Avoids Oxford Drive and uses the new right-lane geometry; it does not traverse the roundabout. |

The compiler uses directed OSM segments (including reverse one-way and roundabout direction), passenger-car access and mapped turn restrictions. It offsets two-way travel to the right, uses City of London pavement to distinguish carriageways from splitter islands, then rounds and resamples the line. The regression checks require College and Stadium to stay outside the central island and circulate counterclockwise. These are rules for generated routes, not a claim that all real-world signage or temporary closures are modeled.

## How Brake becomes a slide

1. A press brakes immediately. Two short releases on Brake qualify: each press at most 220 ms, up to 320 ms between the first release and second press, with movement and proximity limits. A long press, drag, cancelled touch or focus loss does not complete the gesture.
2. The second release starts one **410 ms** handbrake pulse. Brake is not latched. It works while another finger holds Gas, but never adds throttle by itself. A fresh ordinary brake press interrupts the pulse. The paired controller offers optional haptic feedback where supported.
3. The simulation uses speed, steering and rear grip to decide whether the car actually slides. A stationary double-tap is not a launch, and a straight-line double-tap is not a scripted spin. The pedal shows the **request**; the dashboard shows the **result**. Straighten or countersteer to recover.

## Files to change together

| Owner | Source and generated outputs |
|---|---|
| Controller | `server/pad.html` owns paired layout; `web/phone/pad-wheel.js` owns motion steering and the shared gesture; `web/phone/controls.mjs` binds it for direct touch. `server/room.mjs` forwards the optional handbrake and `web/lobby/pair-phone.mjs` merges it with local input. Older pad packets without the field mean no handbrake. |
| HUD and handling | `web/index.html`, `web/drive.js`, `web/ui/components.css`, `web/phone/hud.mjs` and `web/drive-sim.mjs`. The Worker pad styles are inline and are not imported from the Vite stylesheet. `web/lobby/online.mjs` uses the course grid placement. |
| Roads | `build/traffic.py`, `build/drive_route.py`, `build/drive_network.py` → `web/drive-route.json`, `web/drive-network.json`. `web/drive-network.mjs` exposes matched road metadata to the HUD. |
| Replay compatibility | The production build bakes `web/race/courses.mjs`, refreshes `web/race/version.mjs`, and regenerates the three replay fixtures plus expected results. Keep these in the same release as physics/routes. Personal bests and leaderboards are versioned; don't compare laps across versions. |
| Demo media | README links the MP4 and shows an animated WebP thumbnail in `docs/`. The clip shows the roundabout, not a staged drift. |

## Run, verify and roll out

```sh
npm run setup                       # fresh checkout: install dependencies and Python environment
.venv/bin/python build/drive_route.py
.venv/bin/python build/drive_network.py
npm run build                       # regenerate baked courses, version and replays
.venv/bin/python build/test_traffic.py
node web/dev/verify_network.mjs && node web/dev/verify_circuits.mjs
node web/dev/verify_drive_sim.mjs && node server/verify-wheel.mjs
node web/dev/verify_replay.mjs && node server/test-net.mjs
node server/lan.mjs                 # serve the build with the phone relay, port 4173
```

**Device acceptance:** Open the desktop game, choose Phone controller, scan the QR code and tap Start driving. On HTTPS grant motion permission; on plain LAN HTTP use arrows. Check clockwise → right, counterclockwise → left, level → straight. Accelerate on a clear bend, hold Gas, and double-tap Brake: the pedal flashes, the rear steps out, and the HUD reports slip before returning to Grip. Verify single braking, reverse and lifting both thumbs. Neither phone UI should have a third pedal. For route acceptance, run College or Stadium and follow the marked lane around the island, not a chord across it.

**Domain rollout (site owner):** From the intended merged revision, use the existing Cloudflare domain environment: `npm run deploy:domain`. It targets the game Worker, static assets and Durable Object bindings for fwestern.ca and www.fwestern.ca. Do not deploy just the HTML or copy the new pad onto the old Worker. After deployment compare `https://fwestern.ca/api/health` → `sim` with the decimal value of the merged simulation version, reload both clients, pair, and repeat the device check. If smoke tests fail, restore the preceding Worker version **with its matching assets**; do not delete race data.
