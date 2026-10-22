# One-time: create the Valles database + user on your EXISTING Cloud SQL instance,
# and store the password in Secret Manager. Does not touch the IMSE database.

$ErrorActionPreference = "Stop"

$PROJECT_ID = "easy-ems-507406"
$REGION     = "asia-south1"
$INSTANCE   = "ems-postgres"
$DB_NAME    = "valles"
$DB_USER    = "valles_app"
$SECRET     = "valles-db-password"

gcloud config set project $PROJECT_ID

# Strong random password (letters + digits only, so it is safe everywhere)
$chars = (48..57) + (65..90) + (97..122)
$password = -join ($chars | Get-Random -Count 32 | ForEach-Object { [char]$_ })

Write-Host "[1/4] Creating database $DB_NAME ..." -ForegroundColor Yellow
gcloud sql databases create $DB_NAME --instance=$INSTANCE

Write-Host "[2/4] Creating user $DB_USER ..." -ForegroundColor Yellow
gcloud sql users create $DB_USER --instance=$INSTANCE --password=$password

Write-Host "[3/4] Saving password to Secret Manager as $SECRET ..." -ForegroundColor Yellow
$tmp = New-TemporaryFile
[IO.File]::WriteAllText($tmp, $password)
gcloud secrets create $SECRET --data-file=$tmp 2>$null
if ($LASTEXITCODE -ne 0) { gcloud secrets versions add $SECRET --data-file=$tmp }
Remove-Item $tmp

Write-Host "[4/4] Letting Cloud Run read the secret ..." -ForegroundColor Yellow
$projectNumber = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"
gcloud secrets add-iam-policy-binding $SECRET `
    --member="serviceAccount:$projectNumber-compute@developer.gserviceaccount.com" `
    --role="roles/secretmanager.secretAccessor"

Write-Host "Done. Database '$DB_NAME' and user '$DB_USER' are ready on $INSTANCE." -ForegroundColor Green
