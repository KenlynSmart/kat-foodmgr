# kat-foodmgr
Khanh Trinh food toolkit

## Authentication setup

Apply `auth_migration.sql` to Supabase before starting the backend. Configure:

- `SUPABASE_SERVICE_ROLE_KEY` for Google auto-provisioning.
- `AUTH_JWT_SECRET` with a long random value.
- `GOOGLE_OAUTH_REDIRECT_URI` as the deployed `/api/auth/google/callback` URL.
- `FRONTEND_URL` as the frontend origin/path that receives `auth_token`.

Local login reads the bcrypt password hashes already stored in `users`; the
backend never creates or overrides local credentials.
