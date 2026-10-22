# Build and deploy the Valles service to Cloud Run (same pattern as your IMSE script).
# Run scripts/setup-database.ps1 once before the first deploy.
#
# Edit ALLOWED_EMAILS below: only these Google accounts can read or write Valles data.

$ErrorActionPreference = "Stop"

$PROJECT_ID   = "easy-ems-507406"
$REGION       = "asia-south1"
$SERVICE      = "valles-ems"
$IMAGE        = "gcr.io/$PROJECT_ID/valles-ems"
$SQL_INSTANCE = "easy-ems-507406:asia-south1:ems-postgres"

# Valles Google OAuth client (the one already used for Drive sync in the app)
$OAUTH_CLIENT_ID = "870827159813-4g2i299mv9qduqpmju40mpr5f63uvgns.apps.googleusercontent.com"

# Comma-separated Google accounts allowed in. Add each person who uses Valles.
$ALLOWED_EMAILS = "vallesindia@gmail.com"

gcloud config set project $PROJECT_ID

Write-Host "[1/3] Building image ..." -ForegroundColor Yellow
gcloud builds submit --config cloudbuild.yaml --timeout=15m .
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

Write-Host "[2/3] Deploying to Cloud Run ..." -ForegroundColor Yellow
# Settings go in a small YAML file, which avoids Windows quoting problems with commas.
$envFile = Join-Path $env:TEMP "valles-env.yaml"
$yaml = @"
NODE_ENV: "production"
DB_HOST: "/cloudsql/$SQL_INSTANCE"
DB_NAME: "valles"
DB_USER: "valles_app"
GOOGLE_OAUTH_CLIENT_ID: "$OAUTH_CLIENT_ID"
ALLOWED_EMAILS: "$ALLOWED_EMAILS"
"@
Set-Content -Path $envFile -Value $yaml -Encoding ascii

gcloud run deploy $SERVICE `
    --image $IMAGE `
    --region $REGION `
    --platform managed `
    --allow-unauthenticated `
    --port 8080 `
    --memory 512Mi --cpu 1 `
    --min-instances 0 --max-instances 3 `
    --timeout 300 --concurrency 80 `
    --add-cloudsql-instances $SQL_INSTANCE `
    --env-vars-file $envFile `
    --update-secrets "DB_PASSWORD=valles-db-password:latest"
$deployExit = $LASTEXITCODE
Remove-Item $envFile -ErrorAction SilentlyContinue
if ($deployExit -ne 0) { throw "Deploy failed" }

Write-Host "[3/3] Service URL:" -ForegroundColor Yellow
$url = gcloud run services describe $SERVICE --region $REGION --format "value(status.url)"
Write-Host $url -ForegroundColor Green
Write-Host ""
Write-Host "NEXT: add $url to 'Authorized JavaScript origins' on the Valles OAuth client, then open $url" -ForegroundColor Cyan