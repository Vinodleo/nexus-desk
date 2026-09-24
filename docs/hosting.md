# Running Nexus Desk around the clock

The market scanner and the position guardian run on the server. They work
whenever the server is running, whether or not the app is open. So the
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

Two ways to fix that:

| | A. Keep Cloud Run | B. Your own VM with Docker |
|---|---|---|
| Setup | One script | A VM, a domain, Docker |
| Your URL | Unchanged | New domain: update Firebase and Kite |
| Monthly cost (rough) | ~US$40–55 (1 vCPU + 1 GiB always on) | ~US$7–15 (small VM) |
| After AI Studio redeploys | Re-run the script | Not affected: you deploy with `git pull` |

The costs are rough estimates. Check the Google Cloud pricing calculator for
your region.

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
