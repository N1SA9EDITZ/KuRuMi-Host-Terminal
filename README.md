# KuRuMi-Host

A web terminal manager built with Express, Socket.IO, and `node-pty`. Users can sign in, manage terminal instances, and open a bash terminal in the browser.

## Requirements

- Node.js LTS and npm
- MongoDB Atlas or MongoDB server for persistent account signup/login
- Git for Windows (provides `bash`) when running on Windows
- Python 3 and a C++ build toolchain for compiling `node-pty`

On Windows, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select **Desktop development with C++**. On Linux, install Python 3, `make`, and a C++ compiler.

## Run Locally

From the project directory:

```bash
npm install
npm start
```

Open `http://localhost:5000/login.html`. Do not open `public/login.html` directly as a `file://` URL; login requires the Express server.

In Windows PowerShell, use `npm.cmd` if PowerShell blocks the `npm.ps1` script:

```powershell
npm.cmd install
npm.cmd start
```

For MongoDB and Telegram, copy `.env.example` to `.env`, replace placeholders with a newly rotated MongoDB credential and a new token from BotFather, and keep `.env` private. `.env` is ignored by Git. Never paste either secret into source code or commit them. Users must open `@KuRuMi_Host_bot`, press Start, and use `/id` before they can receive a reset OTP.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `5000` |
| `DATA_DIR` | Directory for account data, instances, sessions, and terminal workspaces | Project directory |
| `SESSION_SECRET` | Session-cookie signing secret; required in production | Local development fallback only |
| `MONGODB_URI` | MongoDB connection string for user accounts | Unset; local JSON fallback |
| `MONGODB_DB_NAME` | MongoDB database name | `kurumihost` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for `/start`, `/id`, and OTP delivery | Unset; password recovery disabled |
| `PASSWORD_RESET_SECRET` | HMAC secret for one-time reset codes | `SESSION_SECRET` fallback |
| `ADMIN_USERNAME` | Username allowed to review payment requests | `NISAN` |
| `NAGAD_RECEIVER` | Nagad merchant number shown at checkout | `01775602198` |
| `BKASH_RECEIVER` | Optional bKash merchant number; unset methods are unavailable | Unset |
| `ROCKET_RECEIVER` | Optional Rocket merchant number; unset methods are unavailable | Unset |
| `UPAY_RECEIVER` | Optional Upay merchant number; unset methods are unavailable | Unset |
| `PAYMENT_RECEIVER` | Legacy fallback for `NAGAD_RECEIVER` | Unset |
| `TERMINAL_BACKEND` | `host` for local development or `docker` for paid customer terminals | `host` locally, `docker` in production |
| `DOCKER_TERMINAL_IMAGE` | Preloaded Linux image used for isolated terminals | `ubuntu:24.04` |

When MongoDB is configured, signup/login accounts are stored in the `users` collection. On the first connection to an empty collection, the app imports `users.json` and hashes any legacy plaintext passwords. If `MONGODB_URI` is unset, local development uses `users.json`. A configured MongoDB connection failure stops startup rather than silently switching stores. Orders and terminal instances remain in `orders.json` and `instances.json` under `DATA_DIR`.

`expiry_date: null` means the account does not expire. `instance_count: null` means unlimited terminals; a number is that account's maximum. New signup accounts stay locked until an approved plan activates them. When a paid account expires, it is locked but its account, workspace, and instance records are preserved for renewal.

## Plans and Payments

The public plan page is `/plans.html`: base price ৳100 per calendar month and up to three terminal instances. Available terms are 1, 2, 3, 6, 8, and 12 months. Terms up to 3 months receive 2% off; terms of 6 months or longer receive 5% off. Configured bKash, Nagad, Rocket, or Upay payments are manually reviewed by transaction ID; methods without a receiver number appear as unavailable. Existing customers can renew with their current account password. Sign in as `ADMIN_USERNAME` and open `/admin/orders` to review requests, or `/admin/users` to see creation/expiry dates and remaining days. New purchase passwords are stored as salted scrypt hashes.

## Interface Effects

All screens share a decorative Three.js wireframe background. Pointer/touch presses trigger a particle burst with falling streaks; scrolling gently shifts the scene and reveals content. The animation respects `prefers-reduced-motion`, reduces intensity on mobile, and the copyright year is updated by `public/year.js`.

Checkout stays disabled unless `PAYMENT_RECEIVER` is configured and the isolated Docker backend is ready. Approval also stays blocked unless the server runs as a non-root Linux user, Docker is reachable, and `DOCKER_TERMINAL_IMAGE` is already available locally. Customer shells run with no network, limited CPU/RAM/processes, dropped Linux capabilities, and only that customer's workspace mounted.

## Deploy to Render

The included `render.yaml` defines a paid, always-on Render web service and a 1 GB persistent disk mounted at `/var/data`.

1. Push this repository to GitHub. Keep it private while it contains account data.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Review the service and disk plan, then deploy the Blueprint.

The Blueprint sets `DATA_DIR=/var/data` and generates `SESSION_SECRET`. On first startup, the app copies the repository's `users.json` and `instances.json` into the data directory. Later deploys and restarts use the persistent copies. Back up the disk regularly.

Render Free web services can spin down when idle and do not support persistent disks, so they are not suitable for this app's always-on terminal and file persistence needs. Hosting plans do not guarantee uninterrupted uptime.

Render's native Node service does not provide the Docker daemon required by the paid-terminal approval gate. Use a Linux VPS with Docker for customer terminal sales; a native Render deploy can host the basic app UI, but checkout/approval remains disabled until a supported isolated Docker host is configured.

Vercel Functions are not suitable for the persistent PTY process and local session/workspace storage used by this app.

## Host on a Linux VPS

Use a dedicated Ubuntu VPS for paid customer terminals. Do not expose the Windows development PC through a public tunnel. Keep customer shells isolated, and use rootless Docker where available.

1. Install Node.js LTS, Git, Python 3, `make`, a C++ compiler, and Docker. Create a non-root service account named `kurumihost` and grant it access to the rootless Docker daemon.
2. Clone this private repository into `/opt/kurumi-host`, then run `npm ci` as `kurumihost`.
3. Pull the terminal image as the same service account: `docker pull ubuntu:24.04`.
4. Create `/etc/kurumi-host.env` with persistent settings:

```env
NODE_ENV=production
PORT=5000
DATA_DIR=/var/lib/kurumi-host
ADMIN_USERNAME=NISAN
SESSION_SECRET=<generate a random secret and keep it private>
PAYMENT_RECEIVER=01775602198
TERMINAL_BACKEND=docker
DOCKER_TERMINAL_IMAGE=ubuntu:24.04
```

5. Create `/var/lib/kurumi-host`, make `kurumihost` its owner, and set `/etc/kurumi-host.env` permissions to `600`. Keep backups of this directory; it contains accounts, orders, workspaces, and sessions.
6. Run the app with systemd as the non-root service user. Configure Caddy or Nginx for HTTPS and proxy WebSocket traffic to `127.0.0.1:5000`. Open only SSH, HTTP, and HTTPS in the firewall.
7. Verify Docker is rootless, the `ubuntu:24.04` image is available, HTTPS works, and the admin account can review requests before sharing `/plans.html` with customers.

The current terminal backend disables container networking (`--network=none`). No domain allowlist has been configured, so customer terminals should not be advertised as having internet access. Checkout and account activation stay blocked on hosts that do not pass the Docker readiness check.

## Security

- `users.json` stores passwords and optional GitHub tokens as plaintext. Use a private repository and restrict access; do not commit real GitHub tokens.
- Local `host` terminal mode executes commands on the app machine and is for private development only. Paid customer terminals must use the Docker backend; its default network is disabled.
- Set a unique, persistent `SESSION_SECRET` for production. Changing it invalidates existing sessions.