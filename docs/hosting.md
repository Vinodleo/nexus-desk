# Running Nexus Desk around the clock

The market scanner and the position guardian run on the server. They work
whenever the server is running, whether or not the app is open. With
Autopilot on in paper mode, the server also opens the trades Autopilot
accepts (same limits as in the app), and the app shows them when you next
open it. Live trades still need the app. So the
server has to keep running, and what it saves has to survive a restart:

- **Always running, exactly one copy.** One scanner and one guardian. Two
  copies would each guard the same positions from their own state.
- **Saved state on persistent storage.** Guardian positions, live-order
  records, desk settings and tracked setups are written to `NEXUS_DATA_DIR`
  (default `./data`).

By default, Cloud Run (where AI Studio deploys) meets neither requirement:

- It pauses the CPU between requests and shuts the instance down when no one
  is connected, so the scanner and guardian stop.
- Its disk is in memory, so saved state is lost on every restart and every
  deploy.

Three ways to fix that:

| | A. Cloud Run, always-on | B. Your own VM with Docker | C. Fly.io |
|---|---|---|---|
| Setup | One script | A VM, a domain, Docker | One-time commands, then automatic |
| Address | Unchanged | Your domain | `your-app.fly.dev` (https included) |
| Region | Yours | Yours | Singapore |
| Monthly cost (rough) | ~US$40–55 | ~US$0–15 | ~US$4–7 |
| Updates | AI Studio deploy + re-run the script | `git pull` + rebuild | Every merge to `main`, automatically |

The costs are rough estimates. Check each provider's pricing for your region.

## A. Keep Cloud Run, make it always-on

1. Find your service in the [Cloud Run console](https://console.cloud.google.com/run),
   in the project AI Studio deployed to. You need its **name**, **region** and
   **project ID**.
2. Open **Cloud Shell** (the `>_` button at the top of the console). It has
   `gcloud` ready. Get the script (clone the repo, or paste
   `scripts/cloudrun-always-on.sh` into a file), then run:

   ```bash
   gcloud config set project PROJECT_ID
   bash scripts/cloudrun-always-on.sh SERVICE_NAME REGION
   ```

   The script:
   - creates a bucket `PROJECT_ID-nexus-desk-data` (or pass your own as a third
     argument) and gives the service access to it
   - mounts the bucket at `/data` and sets `NEXUS_DATA_DIR=/data`
   - sets 1 minimum and 1 maximum instance, with CPU always allocated
     (instance-based billing), 1 vCPU and 1 GiB, second-generation environment,
     and a 60-minute request timeout for WebSockets

   It's safe to run again.
3. **After every AI Studio deploy, run it again.** A redeploy may reset these
   settings, and the script puts them back. Then check the app (below).

Prefer the console? Open the service, choose **Edit & deploy new revision**, and set:

- **Container:** Instance-based billing (CPU always allocated), 1 CPU, 1 GiB.
- **Scaling:** min 1, max 1.
- **Execution environment:** second generation.
- **Request timeout:** 3600.
- **Volumes:** add a Cloud Storage bucket volume and mount it at `/data`.
- **Variables:** `NEXUS_DATA_DIR=/data`.

## B. Your own VM with Docker

Any Linux machine with Docker works, such as a small Google Compute Engine,
DigitalOcean or Hetzner VM (1 vCPU, 1–2 GB RAM).

1. Point a domain (e.g. `desk.example.com`) at the machine's IP address.
2. On the machine:

   ```bash
   git clone https://github.com/Vinodleo/nexus-desk && cd nexus-desk
   cp .env.example .env    # fill in your keys and ALLOWED_EMAILS
   echo "DOMAIN=desk.example.com" >> .env
   echo "APP_URL=https://desk.example.com" >> .env
   docker compose up -d --build
   ```

   Caddy gets the HTTPS certificate itself. The app restarts after a crash or a
   reboot, and saved state lives in the `nexus-data` Docker volume.
3. Tell the other services about the new address:
   - **Firebase Authentication → Settings → Authorized domains:** add the
     domain, or sign-in fails.
   - **Kite Connect app → Redirect URL:** `https://desk.example.com/`.
4. Updates: `git pull && docker compose up -d --build`.

When you move, switch the old Cloud Run service's minimum instances back to 0,
so only one server is scanning and guarding.

## C. Fly.io

One machine in Singapore that never stops, with a 1 GB disk for saved state and
an https address. `fly.toml` holds the settings. The GitHub Action
`.github/workflows/fly-deploy.yml` deploys `main` whenever CI passes on it.

### One-time setup (works from a phone)

1. **Fly dashboard:** add a payment method (Account → Billing).
2. **A terminal:** open [Google Cloud Shell](https://shell.cloud.google.com).
   It's free with any Google account and runs in the browser.
3. **Install Fly's tool and sign in:**

   ```bash
   curl -L https://fly.io/install.sh | sh
   export PATH="$HOME/.fly/bin:$PATH"
   fly auth login
   ```

   Open the link it prints and sign in with the account you used for Fly.
4. **Create the app and its disk.** The name must match `app` in
   `fly.toml`. If it's taken, choose another and edit `fly.toml` on GitHub.

   ```bash
   fly apps create nexus-desk-vinodleo
   fly volumes create nexus_data --app nexus-desk-vinodleo --region sin --size 1 --yes
   ```

   Fly no longer offers Mumbai (`bom`); Singapore (`sin`) is the nearest.
   The region here must match `primary_region` in `fly.toml`.
5. **Your settings.** Fill in your values; leave out the ones you don't use:

   ```bash
   fly secrets set --app nexus-desk-vinodleo --stage \
     ALLOWED_EMAILS="you@gmail.com" \
     APP_URL="https://nexus-desk-vinodleo.fly.dev" \
     LIVE_TRADING_ENABLED="false" \
     GEMINI_API_KEY="..." \
     COINDCX_API_KEY="..." COINDCX_API_SECRET="..." \
     ANGEL_API_KEY="..." ANGEL_CLIENT_CODE="..." ANGEL_PIN="..." ANGEL_TOTP_SECRET="..."
   ```

   The `ANGEL_*` settings turn on Indian stocks (see `.env.example`): the
   server scans the Nifty 50 from 9:15 to 3:00 IST and closes stock
   positions at 3:20. Settings → Server → Angel One shows whether it's
   connected.

   `GEMINI_API_KEY` comes from [AI Studio → Get API key](https://aistudio.google.com/apikey).
   Without it, the agents use their rule-based fallbacks. The other
   `LIVE_*` limits in `.env.example` can be added the same way.
6. **Let GitHub deploy.** Create a deploy token:

   ```bash
   fly tokens create deploy --app nexus-desk-vinodleo
   ```

   Copy everything it prints, starting at `FlyV1`. On GitHub, open the repo's
   **Settings → Secrets and variables → Actions → New repository secret**,
   name it `FLY_API_TOKEN`, and paste the value.
7. **First deploy:** on GitHub, open **Actions → Deploy to Fly.io → Run
   workflow** (branch `main`). It takes about 5–10 minutes. After that, every
   merged PR deploys itself once CI passes.
8. **Tell the other services about the new address:**
   - **Firebase Authentication → Settings → Authorized domains:** add
     `nexus-desk-vinodleo.fly.dev`. This must be in a Firebase project you
     own (the app uses `nexus-desk-21656`, see the README): AI Studio's own
     project can't be changed from your account.
   - **Kite Connect app → Redirect URL:** `https://nexus-desk-vinodleo.fly.dev/`.

The paper book, trade history and Lab model live in the browser, per
address, so the Fly address starts with a fresh book.

Logs and the machine's status are in the Fly dashboard, under the app's
**Monitoring** page. To stop paying, destroy the app there or run
`fly apps destroy nexus-desk-vinodleo`.

## Checking it works

- **In the app, Settings → Server:**
  - **Running for** keeps growing. If it keeps resetting, the server is being
    restarted.
  - **Saved state** says **Kept**.
  - **Scanning** says **On the server** with a recent last scan.
- **`https://YOUR_URL/api/health`** answers 200, and `scanner.lastTickAt` is
  within the last 5 minutes. It answers 503 if the scanner's loop has stopped.
  A free uptime monitor (e.g. UptimeRobot) pointed at this URL will alert you.
  The Docker image uses the same check for its health status.
- **Server logs:** at start-up, a `[Host] ... will be lost` warning means the
  saved state isn't on persistent storage.
