# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This is the Designer Digital fork

This repo is a fork of `calcom/cal.diy`, deployed as Designer Digital's self-hosted booking system at `https://book.designer.digital`. The "Cal.diy Engineering Guide" further down is upstream cal.diy's reference for code work. The section below is what you actually need to know about this specific deployment and fork.

## Designer Digital fork — operational context

### Deployment

- **Vercel project**: `dd-bookings` (id `prj_uAa4GM9LovUZfCQNzbSFWEnfemH3`, team `team_aEfzYL3Gg3FiR0lovz2o98HU`). Auto-deploys on push to `main`.
- **Database**: Neon Postgres project `dd-bookings`, US-East. `DATABASE_URL` is the pooled string (`-pooler` in hostname); `DATABASE_DIRECT_URL` is direct (used for migrations).
- **Custom domain**: `book.designer.digital` (CNAME to Vercel). The apex `designerdigital.ca` is the *email* domain only — never serve web from `.ca`.
- **Auth**: single admin user `contact@designerdigital.ca` (role `ADMIN`, `emailVerified` set manually — Resend isn't wired). Open signup is disabled via `NEXT_PUBLIC_DISABLE_SIGNUP=1`.
- **Calendar**: Google Calendar + Meet via `GOOGLE_API_CREDENTIALS` env var. The OAuth client lives in Google Cloud project "Designer Digital Bookings" in Testing mode (unverified app). Refresh tokens may rotate after ~6 months — recovery is "Settings → Calendars → Reconnect" in cal.diy UI; no Cloud Console action needed.
- **SMS**: Twilio with the custom webhook handler at `apps/web/app/api/webhooks/cal-booking/route.ts`. Cal.diy's `Webhook` table has one row registering this URL with HMAC secret matching `CAL_WEBHOOK_SECRET`.
- **Email**: NOT configured. Resend env vars (`EMAIL_SERVER_*`) are placeholders. Calendar invitations come from Google directly (we patched `sendUpdates: "all"`).

### Hard rules

1. **Never trigger a Vercel deploy without explicit user approval.** Build minutes are paid. Detailed rule and reasoning in `~/.claude/projects/-Users-korygoossens-Desktop-Designer-Digital-Websites-dd-booking/memory/feedback_vercel_deploys.md`.
2. **Always run `yarn workspace @calcom/web build` locally before pushing.** Catches issues (module-scope env reads, type errors) without burning Vercel build minutes.
3. **Local build will fail on `/auth/login` page-data collection** with a JSON parse error — that's pre-existing cal.diy behavior caused by missing local env vars. Vercel builds clean. As long as your specific changed file compiles, the local build is "good enough."
4. **Never change `CALENDSO_ENCRYPTION_KEY`.** It encrypts stored OAuth tokens; regenerating bricks every calendar connection.
5. **Show drafted user-facing copy (SMS body, email text, button labels) BEFORE writing it into code.** Even when the user already said "deploy it."
6. **Domain split is sacred**: `designer.digital` is web (NextAuth URL, OAuth redirects, webhook URLs); `designerdigital.ca` is email (Resend domain verification, From: addresses, admin email). Never mix them.

### Custom changes vs upstream cal.diy

These are the deliberate deviations from `calcom/cal.diy/main`. Reverse them only if the user explicitly asks.

- **`apps/web/app/api/webhooks/cal-booking/route.ts`** (NEW): Twilio SMS webhook handler. Twilio client is **lazy-initialized inside the request handler** — initializing at module scope breaks `next build` page-data collection.
- **`packages/app-store/googlecalendar/lib/CalendarService.ts`**: 3× `sendUpdates: "none"` → `"all"`. Without SMTP wired up, Google's emails are the only invite/reschedule/cancel email channel. Revert to `"none"` when/if Resend is enabled (otherwise leads get duplicate emails).
- **`turbo.json`** + four `packages/platform/{constants,enums,types,utils}/package.json`: post-install scripts stubbed to `echo`. The four platform packages have a circular dependency that breaks fresh Vercel `yarn install`; these packages are only used by `apps/api/v2` which we don't deploy.
- **`apps/web/package.json`**: build script is `next build` (upstream has `next build && yarn sentry:release` — no Sentry account). `twilio` is added as a dependency.
- **`apps/web/vercel.json`**: removed empty `"functions": {}` (Vercel rejects schema).
- **DD branding overlay**: `packages/config/theme/tokens.css` (`#000`/`#fff`/`#7a7a7a` palette, forced dark mode), `apps/web/app/layout.tsx` + `apps/web/pages/_document.tsx` + `apps/web/components/PageWrapper.tsx` + `apps/web/app/icons/page.tsx` (Host Grotesk + Barlow Condensed + IBM Plex Mono via `next/font/google`, replacing Inter + Cal Sans), `apps/web/public/dd-{icon,logo-word,logo-word-dark}.svg` + DD favicons. All upstream `cal-*.svg`, `cal.ttf`, `CalSans-SemiBold.woff2` deleted.
- **`packages/lib/constants.ts`**: `LOGO`, `LOGO_DARK`, `LOGO_ICON` point at DD assets; `ROADMAP`, `DOCS_URL`, `JOIN_COMMUNITY`, `POWERED_BY_URL` re-pointed to `https://designer.digital`.
- **Hardcoded `support@cal.com` mailto links**: replaced with `SUPPORT_MAIL_ADDRESS` constant in error page + 4 email templates.
- **`packages/embeds/embed-core/src/styles.css`**: removed remote `https://cal.com/cal.ttf` font URL; uses CSS vars from layout instead.

### Database operations (no psql installed)

To query or update Neon, use ts-node with the Prisma client + adapter pattern. The webhook handler and admin promotion script use this same approach. Template:

```bash
cd packages/prisma
DIRECT=$(grep '^DATABASE_DIRECT_URL=' ../../.env | cut -d= -f2- | tr -d '"')
DATABASE_URL="$DIRECT" ../../node_modules/.bin/ts-node \
  --transpile-only \
  --compiler-options '{"module":"commonjs","esModuleInterop":true}' \
  -e 'import { PrismaPg } from "@prisma/adapter-pg";
      import { PrismaClient } from "./generated/prisma/client";
      const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
      const prisma = new PrismaClient({ adapter });
      (async () => {
        // your query here
        await prisma.$disconnect();
      })();'
```

The PrismaPg adapter is required — cal.diy uses Prisma's "client" engine which won't initialize without it. A fixed reusable script is at `packages/prisma/scripts/promote-admin.ts`.

### Vercel env var operations (via API)

The Vercel CLI is authenticated; the token lives at `~/Library/Application Support/com.vercel.cli/auth.json`.

```bash
VTOKEN=$(python3 -c "import json; print(json.load(open('/Users/korygoossens/Library/Application Support/com.vercel.cli/auth.json'))['token'])")

# List all env vars (sensitive values appear as null without ?decrypt=true)
curl -sS "https://api.vercel.com/v10/projects/prj_uAa4GM9LovUZfCQNzbSFWEnfemH3/env?teamId=team_aEfzYL3Gg3FiR0lovz2o98HU&decrypt=true" \
  -H "Authorization: Bearer $VTOKEN"

# Upsert a single env var
curl -sS -X POST "https://api.vercel.com/v10/projects/prj_uAa4GM9LovUZfCQNzbSFWEnfemH3/env?teamId=team_aEfzYL3Gg3FiR0lovz2o98HU&upsert=true" \
  -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" \
  -d '{"key":"NAME","value":"value","type":"plain","target":["production","preview","development"]}'
```

Sensitive env vars require `"type":"sensitive"` and `target` must NOT include `"development"` (Vercel rejects). Local `.env` and Vercel can drift — the local file is for diagnostics; production reads from Vercel.

### Persistent memory

Memory files for this project live at `~/.claude/projects/-Users-korygoossens-Desktop-Designer-Digital-Websites-dd-booking/memory/`. Read `MEMORY.md` first; it indexes user profile, feedback rules, and project context that persist across Claude sessions.

---

# Cal.diy Engineering Guide (upstream)

You are a senior Cal.diy engineer working in a Yarn/Turbo monorepo. You prioritize type safety, security, and small, reviewable diffs.

## Do

- Use `select` instead of `include` in Prisma queries for performance and security
- Use `import type { X }` for TypeScript type imports
- Use early returns to reduce nesting: `if (!booking) return null;`
- Use `ErrorWithCode` for errors in non-tRPC files (services, repositories, utilities); use `TRPCError` only in tRPC routers
- Use conventional commits: `feat:`, `fix:`, `refactor:`
- Create PRs in draft mode by default
- Run `yarn type-check:ci --force` before concluding CI failures are unrelated to your changes
- Import directly from source files, not barrel files (e.g., `@calcom/ui/components/button` not `@calcom/ui`)
- Add translations to `packages/i18n/locales/en/common.json` for all UI strings
- Use `date-fns` or native `Date` instead of Day.js when timezone awareness isn't needed
- Put permission checks in `page.tsx`, never in `layout.tsx`
- Use `ast-grep` for searching if available; otherwise use `rg` (ripgrep), then fall back to `grep`
- Use Biome for formatting and linting
- Only add code comments that explain **why**, not **what** — see [code comment guidelines](agents/rules/quality-code-comments.md)


## Don't

- Never use `as any` - use proper type-safe solutions instead
- Never expose `credential.key` field in API responses or queries
- Never commit secrets or API keys
- Never modify `*.generated.ts` files directly - they're created by app-store-cli
- Never put business logic in repositories - that belongs in Services
- Never use barrel imports from index.ts files
- Never skip running type checks before pushing
- Never create large PRs (>500 lines or >10 files) - split them instead
- Never add comments that simply restate what the code does (e.g., `// Get the user` above a `getUser()` call)

## PR Size Guidelines

Large PRs are difficult to review, prone to errors, and slow down the development process. Always aim for smaller, self-contained PRs that are easier to understand and review.

### Size Limits

- **Lines changed**: Keep PRs under 500 lines of code (additions + deletions)
- **Files changed**: Keep PRs under 10 code files
- **Single responsibility**: Each PR should do one thing well

**Note**: These limits apply to code files only. Non-code files like documentation (README.md, CHANGELOG.md), lock files (yarn.lock, package-lock.json), and auto-generated files are excluded from the count.

### How to Split Large Changes

When a task requires extensive changes, break it into multiple PRs:

1. **By layer**: Separate database/schema changes, backend logic, and frontend UI into different PRs
2. **By feature component**: Split a feature into its constituent parts (e.g., API endpoint PR, then UI PR, then integration PR)
3. **By refactor vs feature**: Do preparatory refactoring in a separate PR before adding new functionality
4. **By dependency order**: Create PRs in the order they can be merged (base infrastructure first, then features that depend on it)

### Examples of Good PR Splits

**Instead of one large "Add booking notifications" PR:**
- PR 1: Add notification preferences schema and migration
- PR 2: Add notification service and API endpoints
- PR 3: Add notification UI components
- PR 4: Integrate notifications into booking flow

**Instead of one large "Refactor calendar sync" PR:**
- PR 1: Extract calendar sync logic into dedicated service
- PR 2: Add new calendar provider abstraction
- PR 3: Migrate existing providers to new abstraction
- PR 4: Add new calendar provider support

### Benefits of Smaller PRs

- Faster review cycles and quicker feedback
- Easier to identify and fix issues
- Lower risk of merge conflicts
- Simpler to revert if problems arise
- Better git history and easier debugging

## Commands

See [agents/commands.md](agents/commands.md) for full reference. Key commands:

```bash
yarn type-check:ci --force  # Type check (always run before pushing)
yarn biome check --write .  # Lint and format
TZ=UTC yarn test            # Run unit tests
yarn prisma generate        # Regenerate types after schema changes
```


## Boundaries

### Always do
- Run type check on changed files before committing
- Run relevant tests before pushing
- Use `select` in Prisma queries
- Follow conventional commits for PR titles
- Run Biome before pushing

### Ask first
- Adding new dependencies
- Schema changes to `packages/prisma/schema.prisma`
- Changes affecting multiple packages
- Deleting files
- Running full build or E2E suites

### Never do
- Commit secrets, API keys, or `.env` files
- Expose `credential.key` in any query
- Use `as any` type casting
- Force push or rebase shared branches
- Modify generated files directly

## Project Structure

```
apps/web/                    # Main Next.js application
packages/prisma/             # Database schema (schema.prisma) and migrations
packages/trpc/               # tRPC API layer (routers in server/routers/)
packages/ui/                 # Shared UI components
packages/features/           # Feature-specific code
packages/app-store/          # Third-party integrations
packages/lib/                # Shared utilities
```

### Key files
- Routes: `apps/web/app/` (App Router)
- Database schema: `packages/prisma/schema.prisma`
- tRPC routers: `packages/trpc/server/routers/`
- Translations: `packages/i18n/locales/en/common.json`
- Workflow constants: `packages/features/ee/workflows/lib/constants.ts`

## Tech Stack

- **Framework**: Next.js 13+ (App Router in some areas)
- **Language**: TypeScript (strict)
- **Database**: PostgreSQL with Prisma ORM
- **API**: tRPC for type-safe APIs
- **Auth**: NextAuth.js
- **Styling**: Tailwind CSS
- **Testing**: Vitest (unit), Playwright (E2E)
- **i18n**: next-i18next

## Code Examples

### Good error handling

```typescript
// Good - Descriptive error with context
throw new Error(`Unable to create booking: User ${userId} has no available time slots for ${date}`);

// Bad - Generic error
throw new Error("Booking failed");
```

For which error class to use (`ErrorWithCode` vs `TRPCError`) and concrete examples, see [quality-error-handling](agents/rules/quality-error-handling.md).

### Good Prisma query

```typescript
// Good - Use select for performance and security
const booking = await prisma.booking.findFirst({
  select: {
    id: true,
    title: true,
    user: {
      select: {
        id: true,
        name: true,
        email: true,
      }
    }
  }
});

// Bad - Include fetches all fields including sensitive ones
const booking = await prisma.booking.findFirst({
  include: { user: true }
});
```

### Good imports

```typescript
// Good - Type imports and direct paths
import type { User } from "@prisma/client";
import { Button } from "@calcom/ui/components/button";

// Bad - Regular import for types, barrel imports
import { User } from "@prisma/client";
import { Button } from "@calcom/ui";
```

### API v2 Imports (apps/api/v2)

When importing from `@calcom/features` or `@calcom/trpc` into `apps/api/v2`, **do not import directly** because the API v2 app's `tsconfig.json` doesn't have path mappings for these modules, which causes "module not found" errors.

Instead, re-export from `packages/platform/libraries/index.ts` and import from `@calcom/platform-libraries`:

```typescript
// Step 1: In packages/platform/libraries/index.ts, add the export
export { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";

// Step 2: In apps/api/v2, import from platform-libraries
import { ProfileRepository } from "@calcom/platform-libraries";

// Bad - Direct import causes module not found error in apps/api/v2
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
```

## PR Checklist

- [ ] Title follows conventional commits: `feat(scope): description`
- [ ] Type check passes: `yarn type-check:ci --force`
- [ ] Lint passes: `yarn lint:fix`
- [ ] Relevant tests pass
- [ ] Diff is small and focused (<500 lines, <10 files)
- [ ] No secrets or API keys committed
- [ ] UI strings added to translation files
- [ ] Created as draft PR

## When Stuck

- Ask a clarifying question before making large speculative changes
- Propose a short plan for complex tasks
- Open a draft PR with notes if unsure about approach
- Fix type errors before test failures - they're often the root cause
- Run `yarn prisma generate` if you see missing enum/type errors

## Spec-Driven Development (Opt-In)

For complex features, you can use spec-driven development when explicitly requested.

**To enable:** Tell the AI "use spec-driven development" or "follow the spec workflow"

See [SPEC-WORKFLOW.md](SPEC-WORKFLOW.md) for the full workflow documentation.

## Extended Documentation

For detailed information, see the `agents/` directory:

- **[agents/README.md](agents/README.md)** - Rules index and architecture overview
- **[agents/rules/](agents/rules/)** - Modular engineering rules
- **[agents/commands.md](agents/commands.md)** - Complete command reference
- **[agents/knowledge-base.md](agents/knowledge-base.md)** - Domain knowledge and business rules
