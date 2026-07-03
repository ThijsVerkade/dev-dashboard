# dev-dashboard — team onboarding

Get the dashboard + the shared **Knowledge Brain** (Obsidian vault, browsable at
`/brain` and readable/writable by Claude via MCP) running on your machine.

## 0. Prerequisites

- **Node** (see `.nvmrc`/`package.json`) and `npm`
- **Obsidian** desktop app — <https://obsidian.md>
- Access to **GitLab** (`gitlab.bastrucks.com`), **Jira/Confluence** (`bas-tech.atlassian.net`)
- **AWS SSO** access (the dev server's `predev` runs an SSO check)

## 1. Clone & install

```bash
git clone git@github.com:ThijsVerkade/dev-dashboard.git
cd dev-dashboard
npm install
```

You automatically get `.mcp.json` (the Claude Code config for the Obsidian MCP)
and the shared Obsidian config — no setup needed for those.

## 2. Add your tokens (dashboard `/setup` page)

Start the app (`npm run dev`) and open <http://localhost:3000/setup>. The page
has three connect forms; each validates and writes to your local `.env.local`
(never committed):

- **GitLab** — Personal Access Token. Scopes: `api` + `read_repository` for
  everything (pipelines, cloning, triggering jobs & MR notes). Read-only:
  `read_api` + `read_repository` (job triggers & MR comments won't work).
- **Jira** — host + your account email + a **classic** API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>. Classic tokens
  need **no scopes** — they use your Jira account permissions.
- **Obsidian** — host + API key (see step 4).

Tokens can also be set directly in `.env.local` — copy `.env.local.example`.

## 3. Build the Knowledge Brain vault

```bash
npm run brain
```

Generates `./brain/` (gitignored — everyone builds the same vault from the repos
+ Confluence ADRs). View it in the dashboard at <http://localhost:3000/brain>.

## 4. Connect Obsidian (for Claude ↔ vault via MCP)

```bash
npm run obsidian:setup      # downloads the Local REST API plugin into ./brain/.obsidian/
```

Then in Obsidian (one-time GUI steps — can't be scripted):

1. **Open folder as vault** → select this repo's `./brain` directory.
2. **Settings → Community plugins → turn off Restricted Mode**, then enable
   **"Local REST API with MCP"** (already in the plugin list).
3. **Settings → Local REST API** → toggle on **"Enable Non-encrypted (HTTP)
   Server"** (port 27123) → **copy the API key**.
4. Add the key to your shell so Claude Code can read it:
   ```bash
   echo 'export OBSIDIAN_API_KEY="<paste-key>"' >> ~/.zshrc && source ~/.zshrc
   ```
5. **Restart Claude Code** — it'll prompt to approve the `obsidian` MCP server
   (config is in the committed `.mcp.json`). Keep Obsidian open with the vault —
   the server only runs while Obsidian is.

## 5. Run

```bash
npm run dev     # http://localhost:3000  (predev runs AWS SSO + repo checks)
npm test        # the real gate (Vitest)
```

## Notes

- **Secrets never leave your machine**: `.env.local`, the Obsidian API key, and
  the plugin's `data.json` are all gitignored. Each teammate uses their own.
- The Obsidian MCP gives *Claude* read/write access to the vault; the `/brain`
  dashboard route is a separate, read-only in-browser view of the same notes.
