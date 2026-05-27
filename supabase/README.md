# Supabase IaC

`config.toml` is the source of truth for the project's Supabase configuration.
It drives both local dev (via `supabase start`) and the hosted project (via
`supabase config push`).

Per-environment values (URLs, SMTP secrets, OAuth secrets) are not hardcoded —
they reference env vars through Supabase's `env(VAR_NAME)` interpolation. Env
vars come from `supabase/.env` locally (auto-loaded by the CLI) or from the
CI/shell environment when deploying.

## Local development

```bash
cp supabase/.env.example supabase/.env   # one-time
npm run db:start                          # supabase start
```

The CLI looks for `.env.development.local`, `.env.local`, `.env.development`,
and `.env` — first match wins per key. The repo only ships `.env.example`;
everything else is gitignored.

## Deploying config changes to production

Pushes run from `.github/workflows/supabase-config.yml`, which triggers on
pushes to `main` that touch `supabase/config.toml` or `supabase/templates/**`
(plus `workflow_dispatch` for manual runs). It targets the GitHub Actions
`production` environment — the same one that gates the migrations workflow,
so it inherits any approval rules you've set there.

**Required secrets** (`Settings → Environments → production → Secrets`):

| Name | Source | Notes |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase dashboard → Account → Access Tokens | Already configured for migrations. Authenticates the CLI. |
| `PRODUCTION_PROJECT_ID` | Supabase dashboard → Project Settings → Reference ID | Already configured for migrations. |
| `RESEND_API_KEY` | Resend dashboard → Settings → API Keys | The SMTP password Supabase stores on the hosted project. Required — `config push` fails without it. |

**Inlined in the workflow** (NOT secrets):

```yaml
env:
  SUPABASE_AUTH_SITE_URL: https://evolvtrack.com
  SUPABASE_AUTH_REDIRECT_URL: https://evolvtrack.com/**
```

### Precedence — how dev vs. prod stay separated

The Supabase CLI loads env vars in this order:

1. **Existing environment** (workflow `env:` block, or shell exports) — wins.
2. **`supabase/.env`** — fills in anything still unset. The CLI uses
   `godotenv.Load()`, which never overrides already-set vars.

So in CI the workflow's prod URLs win unconditionally. In local dev there's
no shell override, so the developer's `supabase/.env` provides values. The
two paths can't cross-contaminate. The workflow also runs `rm -f` on any
`supabase/.env*` after checkout as a belt-and-suspenders guard.

### Pushing manually from a laptop

For ad-hoc pushes outside CI, set the same vars in `supabase/.env`
(gitignored — safe to put `RESEND_API_KEY` there too) and run:

```bash
npx supabase link --project-ref <prod-ref>   # one-time per checkout
npx supabase config push --project-ref <prod-ref>
```

The CLI auto-loads `supabase/.env`, so no inline `KEY=value` on the command
line — that keeps the key out of shell history.

## ⚠ First-time push warning

`supabase config push` is **replace, not merge**. Any auth/db/storage setting
not represented in `config.toml` will be reset to the CLI's default on the
hosted project.

## Email templates

Customized templates live in `supabase/templates/*.html` and are referenced
from `[auth.email.template.<event>]` blocks in `config.toml`. Currently:

- `magic_link.html` — sign-in link email.

Supabase substitutes Go-template variables when sending:
`{{ .ConfirmationURL }}` (the link), `{{ .Email }}` (recipient),
`{{ .SiteURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .RedirectTo }}`.

To preview a template locally, run `supabase start` and trigger the relevant
auth flow — the email lands in the **Inbucket** viewer at
http://localhost:54324.