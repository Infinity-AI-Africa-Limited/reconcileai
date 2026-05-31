# ReconcileAI

**AI-powered financial reconciliation engine for African banks, fintechs, and corporate B2B payments.**

ReconcileAI auto-matches transactions, flags exceptions by severity, and cuts reconciliation time from days to minutes. Built by [Infinity AI Africa Limited](https://infinityai.africa) as the infrastructure layer for financial reconciliation across Africa.

---

## Live Prototype

**URL:** [https://reconcileai.vip/](https://reconcileai.vip/)  
**Status:** Active prototype — Manus platform  
**Next stage:** Production build on Rocket.new for Lapo MFB pilot

---

## Documentation

All handoff documentation is in the `/docs` folder:

| Document | Purpose |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Full Product Requirements Document — goals, user stories, feature specs |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data models, API contracts, LLM replacement guide |
| [`docs/CONTEXT_HANDOFF.md`](docs/CONTEXT_HANDOFF.md) | What was built, what was left out, known limitations, open questions |
| [`docs/CONVERSATION_SUMMARY.md`](docs/CONVERSATION_SUMMARY.md) | Key decisions, rationale, and context from the build session |
| [`docs/env.example.md`](docs/env.example.md) | Environment variables reference (sanitised) |

**Start with `docs/CONTEXT_HANDOFF.md`** — it is the most important document for the Rocket.new team.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui |
| API | tRPC 11 (end-to-end type safety) |
| Backend | Express 4 + Node.js |
| ORM | Drizzle ORM |
| Database | TiDB (MySQL-compatible) |
| Storage | AWS S3 |
| Auth | JWT session cookies (Manus OAuth in prototype) |
| LLM | Manus Forge (prototype) / Direct OpenAI (production) |
| Language | TypeScript 5 (strict) |

---

## Quick Start (Development)

```bash
# 1. Clone the repository
git clone https://github.com/Infinity-AI-Africa-Limited/reconcileai.git
cd reconcileai

# 2. Install dependencies
pnpm install

# 3. Configure environment variables
# See docs/env.example.md for all required variables
# Copy to .env and fill in values

# 4. Push database schema
pnpm db:push

# 5. Start development server
pnpm dev
```

The app will be available at `http://localhost:3000`.

---

## Rocket.new Import Instructions

1. **Import from GitHub:** In Rocket.new, create a new project and point it at `github.com/Infinity-AI-Africa-Limited/reconcileai`
2. **Set environment variables:** Use the Rocket.new secrets panel to configure all variables from `docs/env.example.md`
3. **Critical:** Set `DIRECT_LLM_API_KEY` to your OpenAI key — this replaces the Manus Forge gateway automatically
4. **Replace authentication:** The Manus OAuth in `server/_core/oauth.ts` must be replaced with email/password auth (see `docs/ARCHITECTURE.md` Section 6.2)
5. **Configure custom domain:** Add `reconcileai.vip` as a custom domain in Rocket.new project settings, then update the DNS CNAME record to point to the Rocket.new deployment URL

---

## Deploying to reconcileai.vip

The domain `reconcileai.vip` is already registered. To point it at the Rocket.new deployment:

1. Get the Rocket.new deployment URL (e.g., `reconcileai.rocket.app`)
2. In your DNS provider, update the CNAME records:
   ```
   @ → <rocket.new deployment URL>
   www → <rocket.new deployment URL>
   ```
3. Add `reconcileai.vip` as a custom domain in Rocket.new project settings
4. Rocket.new will provision a TLS certificate automatically
5. TTL: set to 300 seconds for fast propagation during the cutover

---

## Project Structure

```
reconcileai/
├── client/src/
│   ├── pages/          ← 50+ page components
│   ├── components/     ← DashboardLayout, AIChatBox, Map, etc.
│   ├── contexts/       ← PortalContext (portal switcher)
│   └── App.tsx         ← Routes
├── server/
│   ├── _core/          ← Framework plumbing (do not edit)
│   ├── routers.ts      ← All tRPC procedures (40+ routers)
│   └── db.ts           ← Query helpers
├── drizzle/
│   └── schema.ts       ← Database schema (50+ tables)
├── docs/               ← Handoff documentation
└── package.json
```

---

## Key Contacts

| Role | Name | Organisation |
|---|---|---|
| Founder, CEO & CPO | Richard Anwanakak | Infinity AI Africa Limited |
| GitHub (primary) | [Infinity-AI-Africa-Limited](https://github.com/Infinity-AI-Africa-Limited) | — |
| GitHub (secondary) | [MistaRichMan](https://github.com/MistaRichMan) | — |

---

## Licence

Proprietary — Infinity AI Africa Limited. All rights reserved.
