# DarFlow inbox contract — `darflow-agent/expense v1`

When the manager approves an expense on WhatsApp (**OK** / *wakha*), the agent writes one JSON file per expense to the inbox folder (`DARFLOW_INBOX`, default `data/darflow-inbox/`). The file is written as `*.tmp` and then renamed, so DarFlow never reads a half-written file.

DarFlow (the riad's desktop software) lists these files under **Dépenses → WhatsApp (n)**. It imports each one **through its own business functions** (`createExpense` / `createPurchase`), so its usual checks still apply: amounts, no future dates, cash available, duplicates, closed months, and the audit log. A file that is imported moves to `imported/` together with a `.result.json` holding the DarFlow references. A file that is refused stays in the inbox with the reason. The agent never writes into DarFlow's database.

```json
{
  "source": "darflow-agent", "version": 1, "id": "exp_…",
  "kind": "purchase",                       // "purchase" = supplier bill still to pay · "expense" = already paid
  "date": "2026-10-06", "due_date": "2026-11-12", "doc_number": "D260927206417",
  "supplier": { "name": "SRM Marrakech-Safi", "ice": null },
  "payment_method": null,                   // "CASH" | "CARD" | "TRANSFER" for paid expenses
  "lines": [
    { "label": "Eau domestique 18 m3", "amount_cents": 17244, "category_code": "WATER",  "vat_rate_bp": 700 },
    { "label": "Électricité 427 kWh",  "amount_cents": 69839, "category_code": "ENERGY", "vat_rate_bp": 1400 }
  ],
  "attachment": "data:image/jpeg;base64,…",  // the sheet cropped by SAM 3.1
  "notes": ["Ombre en bas …"], "heard": null // transcript, for voice expenses
}
```

Amounts are in centimes TTC, and `category_code` uses DarFlow's expense categories. The mapping lives in `src/adapters/darflow.js`.
