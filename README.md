# GitHub Copilot for Azure Data Studio

An Azure Data Studio extension that brings **GitHub Copilot** AI assistance directly into your SQL workflow — inline completions, a chat panel, query explanation, generation, fixing, and optimisation.

---

## Features

### ✨ Inline SQL Completions
As you type SQL, Copilot suggests continuations as ghost text. Press **Tab** to accept a suggestion.

Inline completions are:
- Context-aware — the full SQL file is included as context
- Schema-aware — the active database connection's table/column names are injected (configurable)
- Debounced so they don't fire on every keystroke

### 💬 Copilot Chat Participant (`@sql`)
When GitHub Copilot Chat is installed, use `@sql` in the Copilot Chat panel:

| Command | Description |
|---------|-------------|
| `@sql /explain` | Explain the selected or provided SQL query |
| `@sql /generate` | Generate SQL from a natural-language description |
| `@sql /fix` | Fix errors in a SQL query |
| `@sql /optimize` | Suggest performance improvements |
| `@sql /schema` | Show the active database schema |
| `@sql <question>` | Ask any SQL question |

### 🔍 Query Explanation
Select a SQL query and run **ADS Copilot: Explain Query** to get a plain-English explanation in a side panel.

### 🛠️ Query Generation
Run **ADS Copilot: Generate SQL from Description**, type a description, and the generated SQL is inserted at your cursor.

### 🔧 Query Fixing
Select a broken query and run **ADS Copilot: Fix SQL Error**. Optionally paste the error message for a more accurate fix.

### 🚀 Query Optimisation
Select a query and run **ADS Copilot: Optimise Query** to get performance improvement suggestions.

### 🔵 CodeLens Actions
Above each SQL statement you'll see Copilot action lenses:

```
✨ Explain  🚀 Optimise  🔧 Fix
SELECT id, name FROM customers WHERE ...
```

### 💬 Standalone Chat Panel
If GitHub Copilot Chat isn't installed, use **ADS Copilot: Open Chat** (or `Ctrl+Shift+I`) to open a built-in chat panel backed by the VS Code Language Model API.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| **Azure Data Studio** ≥ 1.40 | Or VS Code ≥ 1.85 |
| **GitHub Copilot** extension | For language model access |
| **GitHub Copilot Chat** extension | Optional — enables `@sql` chat participant |
| Active **GitHub Copilot subscription** | Required for AI completions |

---

## Installation

### From VSIX (manual)
1. Download the latest `.vsix` from the [Releases](https://github.com/RatherFancyCat/ADS-Copilot-Integratioon/releases) page
2. In Azure Data Studio: **File → Install Extension from VSIX…**
3. Select the downloaded file and restart ADS

### From source
```bash
git clone https://github.com/RatherFancyCat/ADS-Copilot-Integratioon.git
cd ADS-Copilot-Integratioon
npm install
npm run compile
npx vsce package
```
Then install the generated `.vsix` as above.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ads-copilot.enable` | `true` | Master switch for the extension |
| `ads-copilot.inlineCompletions` | `true` | Enable inline ghost-text completions |
| `ads-copilot.includeSchemaContext` | `true` | Inject active DB schema into prompts |
| `ads-copilot.codeLens` | `true` | Show Copilot CodeLens above SQL statements |
| `ads-copilot.model` | `gpt-4o` | Preferred language model |
| `ads-copilot.maxTokens` | `1024` | Max completion tokens (UI only; model-enforced at runtime) |
| `ads-copilot.logLevel` | `info` | Log verbosity (`error`/`warn`/`info`/`debug`) |

---

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Open Copilot Chat panel |
| `Ctrl+Shift+E` / `Cmd+Shift+E` | Explain selected query |

---

## How It Works

```
┌─────────────────────────────────────────────┐
│              Azure Data Studio               │
│                                              │
│  SQL Editor  ──── Inline Completion ─────┐  │
│                   Provider               │  │
│  Object Explorer ─ ConnectionManager ────┤  │
│  (schema metadata)                       │  │
│                                          ▼  │
│                              LmService       │
│                         (vscode.lm API)      │
│                               │             │
│                               ▼             │
│                    GitHub Copilot LLM        │
│                    (GPT-4o / GPT-4 / etc.)   │
└─────────────────────────────────────────────┘
```

1. **InlineCompletionProvider** — listens to the SQL editor, builds a prompt from the document prefix/suffix and optional schema context, calls the LM, and returns a ghost-text suggestion.
2. **ConnectionManager** — wraps the `azdata.connection` API to provide the active server/database name and table metadata for schema-aware prompts.
3. **LmService** — thin wrapper around `vscode.lm.selectChatModels()` + `model.sendRequest()` that constructs SQL-expert system prompts and streams responses.
4. **ChatParticipant** — registers `@sql` in the Copilot Chat panel with slash commands.
5. **ChatPanel** — standalone WebView chat UI, activated by `ads-copilot.openChat`.
6. **SqlCodeLensProvider** — adds per-statement Explain / Optimise / Fix actions in the gutter.

---

## Contributing

Issues and pull requests are welcome at [RatherFancyCat/ADS-Copilot-Integratioon](https://github.com/RatherFancyCat/ADS-Copilot-Integratioon).

```bash
# Development setup
npm install
npm run watch        # TypeScript watch mode
# Open in VS Code / ADS and press F5 to launch Extension Host
```

---

## License

MIT — see [LICENSE](LICENSE) for details.