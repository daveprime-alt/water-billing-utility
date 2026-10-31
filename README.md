
# Code Review Pushback (A Small Warning)

Take a look at how we are mapping user roles right now. In your schema.prisma file, the role field is a standard string matching "CONSUMER", "ADMIN", or "READER".
Inside your auth.js payload generator, you typed role: user.role (which passes that string parameter down perfectly). However, if you ever add new admin management endpoints later on, make sure to add an explicit updateUser routine inside an adminController.js file rather than expanding the consumer's self-service profile route—otherwise, malicious API payloads could easily manipulate configuration flags.

## API security middleware

- API requests are limited to 100 requests per IP address per 15-minute window; login attempts have a separate 10-request limit.
- The M-Pesa callback endpoint has a separate limit of 300 requests per IP address per 15-minute window to allow provider retries.
- Set `CORS_ORIGINS` to a comma-separated list of exact frontend origins (for example, `https://billing.example.com`). In non-production environments, `http://localhost:4000` and `http://localhost:5173` are allowed by default. In production, no cross-origin browser access is enabled unless origins are configured.
- If the API runs behind a reverse proxy or load balancer, configure Express proxy trust only for the known proxy hops so rate limiting uses the actual client IP safely.

## Authentication

- Sign in with `POST /api/users/login` and JSON `{ "phoneNumber": "0712345678", "password": "..." }`.
- New and admin-reset passwords start as the account's normalized phone number (`2547XXXXXXXX`). A login with that temporary password receives a restricted token and must change it using `POST /api/users/change-password` before accessing other protected routes. Sign in again after changing it.
- Change a password with `{ "currentPassword": "...", "newPassword": "..." }`. New passwords must be at least 8 characters, no more than 72 UTF-8 bytes, and cannot equal the phone number.
- An authenticated admin can create a consumer or reader using `POST /api/admin/users`, reset a user's password with `POST /api/admin/users/:id/reset-password`, correct a missing/changed phone number with `PATCH /api/admin/users/:id/phone` and `{ "phoneNumber": "0712345678" }`, request removal with `DELETE /api/admin/users/:id/phone`, or delete an account with `DELETE /api/admin/users/:id`. Phone removal currently returns HTTP 409 for accounts with a phone number because phone number is the sign-in identifier; an alternate sign-in method must be implemented before phone removal can safely succeed. Deletion is blocked with HTTP 409 if the account has linked reading or billing history. Phone correction also resets the temporary password. Admins must verify the user's identity outside the application before resetting or changing phone numbers.
- Phone-number passwords are predictable and are only a temporary bootstrap. Tell users to change them immediately; do not distribute temporary credentials over an unverified channel.
- To provision the first admin on a fresh database, set `BOOTSTRAP_ADMIN_FIRST_NAME`, `BOOTSTRAP_ADMIN_LAST_NAME`, `BOOTSTRAP_ADMIN_PHONE`, and a unique strong `BOOTSTRAP_ADMIN_PASSWORD` in the local environment, then run `npm run db:bootstrap-admin`. This command refuses to run once an admin exists; remove those bootstrap values afterward

## Known API limitations

- There is no public signup endpoint; admins create accounts.
- There is no endpoint to fetch an invoice by ID.
- `GET /api/invoices/my-bills` currently returns invoice records without the related meter-reading details, so the frontend may not have enough information to show usage for a bill.
- The directory endpoint allows a reader/admin to select a customer for reading entry.
- Spreadsheet customer imports skip an existing customer when normalized name and phone number match; if either record has no valid phone number, a matching normalized name is sufficient. Phone numbers remain globally unique, so a phone already assigned to another customer is skipped as a conflict.
- Password recovery is admin-assisted; there is no self-service forgot-password endpoint

`GET /api/readings` is available to admins and readers. Admins can view all billing periods; readers remain restricted to readings from the current UTC billing month and may correct only their own readings from that month. Each response includes the consumer ID, display name, and account number; billing month; previous reading; consumption units; reading timestamp; and reader ID/display name. Phone numbers and credentials are excluded, and missing legacy values are returned as `null`.

## SMS delivery

Bill notices (excluding invoices held for review), successful M-Pesa receipts, overdue reminders, and admin-created operational announcements are written to PostgreSQL's SMS queue. Correction and unusual-usage notices are not sent in the initial SMS release.

Run the worker separately from the API:

```bash
npm run sms:worker
```

The worker sends at a controlled pace, retries temporary provider failures up to three times after the initial attempt, and leaves permanent failures for admin review. It scans unpaid invoices for one reminder at 9:00 AM Africa/Nairobi on the third calendar day after the due date. The database queue is deduplicated per invoice, payment transaction, reminder, or campaign recipient. An accepted provider request is recorded as `SENT`; this is not proof of handset delivery.

Configure `SMS_ENABLED=true`, Africa's Talking credentials, `AFRICASTALKING_ENV=sandbox`, `AFRICASTALKING_SANDBOX_URL`, and `CUSTOMER_PORTAL_URL` before sandbox testing. The production endpoint is configured with `AFRICASTALKING_PRODUCTION_URL`. Both endpoint values must be the canonical HTTPS messaging URL for their respective environment. Live mode additionally requires `AFRICASTALKING_ENV=production`, the explicit `SMS_LIVE_ENABLED=true` flag, and an approved sender ID; keep live mode off until production credentials and sender ID are approved. Never commit `.env` or provider credentials. See [.env.example](./.env.example) for the variable names.

Admin-only API routes are available under `/api/admin/sms`:

- `GET /messages?status=FAILED` lists queue status and attempt history with recipients masked.
- `POST /messages/:id/retry` manually retries a failed message without deleting its prior attempt history.
- `GET /announcement-recipients` previews eligible consumers, excluding those with an admin-recorded opt-out.
- `GET /announcement-preferences` and `PATCH /announcement-preferences/:userId` manage operational-announcement opt-outs.
- `POST /campaigns` creates an operational announcement draft. `POST /campaigns/:id/preview` returns the preview and current recipient count; `POST /campaigns/:id/confirm` queues the campaign only if the preview is recent, the exact eligible users and phone numbers still match the preview, and the count is at most 1,000.
- `GET /campaigns` lists campaigns. `POST /campaigns/:id/pause` pauses unsent campaign messages; `POST /campaigns/:id/resume` resumes them.
- `GET /audit` shows administrative campaign, opt-out, and manual-retry actions.

Completed, failed, and cancelled message details are redacted after 90 days; queue and attempt metadata remains for operational history. Campaign sends are paced by `SMS_SEND_INTERVAL_MS` (default one recipient per second) and can be paused by an admin; an already in-flight provider request may finish during a pause. Run one worker instance initially so pacing remains within the configured per-process rate.

Pending SMS rows created before the workflow migration are tagged `legacy`. The worker deliberately does not send these rows; review them manually before changing or removing them.

The API and worker can be run as separate Docker Compose services while PostgreSQL stays on the VPS host:

```bash
# Merge the settings in .env.example into your existing .env without overwriting secrets.
# Set DATABASE_URL to PostgreSQL reachable from the containers before starting.
docker compose build
docker compose run --rm api npm run db:deploy
docker compose up -d
```

Inside these containers, `localhost` refers to the container. Compose maps `host.docker.internal` to the host gateway for both services, and does not publish a PostgreSQL port. Set `DATABASE_URL` to use that hostname and the host-installed PostgreSQL port. The Compose setting provides a route, but cannot secure PostgreSQL by itself: bind PostgreSQL only to the host gateway/interface needed by Docker (not public interfaces), allow the Compose network's source subnet in `pg_hba.conf` and the host firewall only for the required database/user, and deny public ingress to port 5432. Determine the actual gateway and Compose subnet on the VPS before configuring these rules; do not assume this workspace's Docker network addresses match production. Verify the VPS firewall and PostgreSQL `listen_addresses`/`pg_hba.conf` directly before deployment. Apply Prisma migrations as a controlled deployment step before starting the new worker:

```bash
npm run db:deploy
```

The repository currently contains the backend/API only; it does not include the admin frontend.
