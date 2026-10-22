# Valles EASY EMS on Cloud Run + Cloud SQL

Your app's `index.html` is **not modified**. The server adds one `<script>` tag when it serves the page.
That script (`frontend/shim/valles-shim.js`) redirects only the app's Drive `data.json` and `backup-*.json`
calls to this server. Folders, attachments, the Google Sheet export and Google sign-in still go to Google.
All payroll, TDS, GST and invoice logic keeps running in the browser, exactly as before.

## What is stored where
| Thing | Where |
|---|---|
| App data (staff, payslips, bills, parties, documents, transactions, compliance, presence) | Cloud SQL, table `app_state` (same JSON the app used to put in Drive `data.json`) |
| Change history (point-in-time recovery) | `state_history` (throttled, last 300; always kept before a large shrink) |
| Backups made from the app's Backup screen | `backups` |
| Attachments, Google Sheet export | Still Google Drive |

## One-time setup (PowerShell, same style as your IMSE scripts)
1. `gcloud auth login` as the account that owns project `easy-ems-507406`.
2. `.\scripts\setup-database.ps1` creates database `valles` + user `valles_app` on instance `ems-postgres`
   and puts the password in Secret Manager (`valles-db-password`). It does not touch the IMSE database.
3. Edit `ALLOWED_EMAILS` in `scripts/deploy.ps1` (every Google account that should be able to use Valles).
4. `.\scripts\deploy.ps1` builds and deploys the Cloud Run service `valles-ems`.
5. Add the printed service URL to **Authorized JavaScript origins** on the Valles OAuth client
   (Google Cloud Console → APIs & Services → Credentials). Without this, Google sign-in fails.
6. Open the URL. Connect Google Drive in Settings as you do today.

## First open: your existing data moves over automatically
The first time the app syncs and the database is empty, the bridge copies your current Drive `data.json`
into Postgres. Nothing to export or import by hand. (Do this from the browser that has the latest data.)

## Safety
- Every API call needs a Google token issued to the Valles OAuth client **and** an email in `ALLOWED_EMAILS`.
  If either setting is missing the server refuses everyone.
- An empty save can never replace real data; a save that drops more than 20% of records first keeps the old state in `state_history`.
- `?backend=drive` on the page URL turns the bridge off for that load (talks to Drive directly, as before).

## Updating the app later
Replace `frontend/index.html` with the new version and run `.\scripts\deploy.ps1`. Nothing else changes.

## Tests (already run)
- `npm test` with `TEST_DATABASE_URL` set: API, auth, safety rules, backups.
- `node test/e2e.mjs`: loads your real app in Chromium against the server and Postgres.

## Not covered yet
- Cloud Build and the deploy were not run from here (no access to your Google Cloud). Run the scripts and tell me what you see.
- Normalised tables (one row per employee/payslip/bill) are not created. The data is stored as the app's JSON, with history. Reporting tables can be added later without changing the app.
