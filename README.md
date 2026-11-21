# Relay Intake
A multilingual **fictional-patient rehearsal**, built for Hack Western 13 (Sun Life / Gemini). It is not clinically validated, not a diagnosis, and not for care decisions. Do not enter personal information or use a real prescription bottle.

## Run
Use Node 22.16+ or 24, then:
```sh
npm ci
npm run dev
```
Open the printed address. **Start a rehearsal** works without an API key. Choose *A sticky eye*, enter the scripted lines, confirm the read-back, then create a temporary QR note. **Case library** has all seven scripts; the support case is hidden behind an explicit private-rehearsal control.

## Live interview
Copy `.env.example` to `.env.local` and supply a Gemini Developer API key server-side; do not prefix it with NEXT_PUBLIC. Restart Next.js. The key must have access to both configured models. Use **Open studio → fictional data consent → Connect live voice**. Tap to start a turn; tap again to send. Microphone and camera require HTTPS or localhost. Text and recorded-turn requests use the ordinary Gemini API. Without a key, scripted rehearsals, manual capture, explicit safety buttons, maps, notes and QR sharing remain usable; there is **no simulated model response presented as live AI**.

The browser obtains a constrained one-use token, sends 16 kHz PCM to Gemini Live, and plays 24 kHz output. A still photo goes to the label endpoint only on request. Confirm what it read. If unreadable, retake once or bring the bottle. Do not upload real labels. On quota failure, stop paid requests and switch to rehearsals. Do not rotate keys to evade quotas.

## Verification
```sh
npm test
npm run lint
npm run check
npm run build
npm start
```
The suite runs each of seven scripted fixtures ten times and tests negation, child/pregnancy floors, crisis precedence, invalid evidence, stale note IDs and expiry. These are deterministic software checks, **not** seventy live interviews or clinical validation. Before the fair, test audio in both languages, camera, QR on a second phone, and interruptions on the venue network. Have a qualified clinician review the proposed routing. Never present scripted results as live Gemini.

## Architecture and limits
- `src/contract.ts`, `state/`, `rules/`: closed vocabulary, evidence-indexed reducer, red flag lock and deterministic routes. Positive current or unclear emergency findings stop the interview. No stay-home outcome. Model transcripts may be inaccurate, which a schema alone cannot detect.
- `src/live/`, `app/api/`: server-minted credentials, push-to-talk audio, captions, validated tools, ordinary multimodal fallback and confirmed label capture. No model chooses the route. Spoken model output is not guaranteed safe: use only fictional cases.
- `src/ui/`: two-language rehearsals, case panel, transcript, read-back, route card and London directory. Directory order is relative to the **Western campus**, not the user's GPS. Sources are linked; call ahead. Do not infer live hours or wait times.
- `src/note/`: each evidence line links to an original patient turn. An ordinary Gemini JSON call orders grounded English lines and must return a full permutation; one retry then local template. Share tokens contain no transcript. Anyone with the link can read it until expiry.
- Browser session state is tab-scoped with a 30-minute rehearsal expiry. Start over clears local state and stops devices. Temporary notes have a separate 30-minute in-memory TTL. No accounts, database, app transcript logs or analytics. Gemini requests are subject to the provider's data terms; local expiry does not delete provider data. HTTPS and an access-controlled host are required for live demos.

## Hosting
For dependable QR handoff use **one long-running Node process**, accessible to both devices. Build then run `npm start -- --hostname 0.0.0.0` behind HTTPS. A phone cannot open a laptop's localhost link, and private previews require viewer access. Restarting the server discards all notes. Stateless Vercel functions or multiple replicas cannot guarantee a shared in-memory note store; use the same-screen evidence note there, or deploy the single-instance configuration. Do not enable a paid Gemini key on an unrestricted public deployment without an operator-managed access gate, per-user quotas and spend limits.

See [rehearsal and submission guide](docs/demo.md), [Gemini Live](https://ai.google.dev/gemini-api/docs/live), [ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens), [Ontario Health811](https://health811.ontario.ca/), and [Canada 9-8-8](https://988.ca/).
