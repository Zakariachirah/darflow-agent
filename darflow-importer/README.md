# DarFlow importer (written during the hackathon)

DarFlow is the author's own riad management software (Windows desktop app, Electron + TypeScript, closed source). It existed before the hackathon and is **not** in this repository.

This week, the only change made to DarFlow is the small importer that receives the expenses approved on WhatsApp. Its two files are copied here so the jury can read them:

| File | What it does |
|---|---|
| [`agentInbox.ts`](agentInbox.ts) | Reads the agent's inbox folder (contract: [`../docs/darflow-inbox.md`](../docs/darflow-inbox.md)), shows a preview, and imports each file in its own transaction through DarFlow's existing business functions (`createExpense` / `createPurchase`), which keep their own checks: amounts, dates, cash, duplicates, closed months, attachment, audit log. Unpaid bills become *purchases* whose HT is chosen so the TTC matches the bill to the centime. Imported files move to `imported/` with a `.result.json`. |
| [`agent-inbox.test.ts`](agent-inbox.test.ts) | Tests: water + electricity bill → unpaid purchase at 880.21 DH to the centime; voice-note gas expense paid by card; junk file refused; a second import does nothing; a negative amount is refused; a future date is never booked. |

The wiring around it is a few lines in DarFlow's own files: two API routes (`agentInbox.list`, `agentInbox.import`), the closed-month guard, and a **WhatsApp (n)** button with a preview window on the *Dépenses* page (French, English and Arabic labels).

These files import DarFlow internals (`../context`, `./purchasing`, …), so they do not compile on their own. Inside DarFlow, the full test suite passes: 248 tests, 0 failures.

The agent never writes into DarFlow's database. It only drops a JSON file (`src/adapters/darflow.js`); DarFlow decides what to import.
