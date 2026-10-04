# Tool capability inventory — G2.3.1 / G2.3.2 / G2.3.3

**Snapshot:** 2026-10-04  
**Source of truth for tool count:** `apps/agent/src/generated/http-tools.ts` (regenerated via `scripts/generate-agent-tools.mjs` from `apps/api/openapi/agent-tools.openapi.json`) — 54 generated API tools; 74 classified rows total (53 api + 21 planned).  
**API comparison:** `apps/api/src/routes/`.  
**UI comparison:** canonical PWA pages under `apps/pwa/src/features/`.

## Metadata contract

Every row is required to contain these columns: `Capability ID`, `Tool`, `Semantic capability`, `Persona`, `Frequency`, `Risk`, `API`, `UI`, `Destination`, and `Coverage`.

Allowed `Destination` values are exactly `UI`, `chat`, `internal`, and `retire`. `Persona` is the intended caller (`member`, `member/owner`, or `agent/operator`); it is not an implementation team. `Frequency` is a planning cadence, not an SLA. `Risk` is the highest plausible impact of an incorrect execution.

## Coverage classification

- **covered** — equivalent API route and a PWA surface are present.
- **api-only** — equivalent API route exists, but no dedicated PWA control was found.
- **partial** — related API/UI data exists, but not the tool's complete capability.
- **chat-only** — currently implemented by the Pi tool; no equivalent API route was found.
- **internal** — automation, scoring, reminder, or notification processing without a user-facing API command.

Capability IDs are stable inventory identifiers, not tool names. One registered tool maps to one capability; aliases in filenames are not additional capabilities.

| ID | Tool | Semantic capability | Persona | Frequency | Risk | API | UI | Destination | Coverage | kind | method | path | openapiOperationId | routeInventoryId | adapterExport | approval | status |
|---|---|---|---|---|---|---|---|---|---|
| CAP-001 | `list_accounts` | List active accounts and balances | member | daily | low | `GET /accounts` | Accounts, Wallet | UI | covered | query | GET | /accounts | — | accounts-list | — | none | api |
| CAP-002 | `list_categories` | List active income/expense categories | member | daily | low | `GET /categories` | Categories, Records | UI | covered | query | GET | /categories | — | categories-list | — | none | api |
| CAP-003 | `get_balance` | Calculate one account balance | member | daily | low | Related balance fields in `GET /accounts`; aggregate `GET /dashboard/summary` | Wallet, Home | UI | partial | query | GET | /accounts | — | accounts-list | — | none | api |
| CAP-004 | `get_month_summary` | Monthly income, expense, and count summary | member | monthly | low | Aggregate `GET /dashboard/summary` | Home, Reports | UI | partial | query | GET | /dashboard/summary | — | dashboard-summary | — | none | api |
| CAP-005 | `list_recent_transactions` | List recent transactions, optionally by account | member | daily | low | `GET /transactions` with filters | Records | UI | covered | query | GET | /transactions | — | transactions-list | — | none | api |
| CAP-006 | `get_pending_operation` | Read a pending high-value operation for a chat | agent/operator | event-driven | low | `GET /pending-operations/details` | No dedicated surface | chat | api-only | query | GET | /pending-operations/details | get_pending_operation | pending-operations-details-dual | — | none | api |
| CAP-007 | `audit_logs` | Read immutable operation/audit history | agent/operator | on-demand | low | `GET /audit-logs` | No dedicated surface | chat | api-only | query | GET | /audit-logs | — | audit-logs-list | — | none | api |
| CAP-008 | `create_account` | Create a bank, cash, or card account | member | on-demand | medium | `POST /accounts` | Accounts, Wallet | UI | covered | command | POST | /accounts | — | accounts-create | — | none | api |
| CAP-009 | `create_category` | Create an income or expense category | member | on-demand | medium | `POST /categories` | Categories | UI | covered | command | POST | /categories | — | categories-create | — | none | api |
| CAP-010 | `create_expense` | Register an expense transaction | member | daily | high | `POST /transactions/expense` | Records | UI | covered | command | POST | /transactions/expense | — | transactions-expense-create | — | policy | api |
| CAP-011 | `create_income` | Register an income transaction | member | daily | high | `POST /transactions/income` | Records | UI | covered | command | POST | /transactions/income | — | transactions-income-create | — | policy | api |
| CAP-012 | `create_transfer` | Transfer between own or third-party accounts | member | daily | high | `POST /transfers` | Records | UI | covered | command | POST | /transfers | — | transfers-create | — | policy | api |
| CAP-013 | `update_account` | Rename an account | member/owner | on-demand | medium | `PATCH /accounts/:id` | Accounts | UI | covered | command | PATCH | /accounts/:id | — | accounts-update | — | none | api |
| CAP-014 | `deactivate_account` | Deactivate an unused account | member/owner | on-demand | medium | `POST /accounts/:id/deactivate` | Accounts | UI | covered | command | POST | /accounts/:id/deactivate | — | accounts-deactivate | — | none | api |
| CAP-015 | `update_category` | Rename or change category kind | member/owner | on-demand | medium | `PATCH /categories/:id` | Categories | UI | covered | command | PATCH | /categories/:id | — | categories-update | — | none | api |
| CAP-016 | `deactivate_category` | Deactivate an unused category | member/owner | on-demand | medium | `POST /categories/:id/deactivate` | Categories | UI | covered | command | POST | /categories/:id/deactivate | — | categories-deactivate | — | none | api |
| CAP-017 | `update_transaction` | Edit a transaction | member | on-demand | medium | `PATCH /transactions/:id` | Records | UI | covered | command | PATCH | /transactions/:id | — | transactions-update | — | none | api |
| CAP-018 | `delete_transaction` | Soft-delete a transaction | member | on-demand | critical | `DELETE /transactions/:id` | Records | UI | covered | command | DELETE | /transactions/:id | — | transactions-delete | — | policy | api |
| CAP-019 | `confirm_pending_operation` | Approve and execute a pending operation | agent/operator | event-driven | critical | `POST /pending-operations/approve` | No dedicated surface | chat | api-only | command | POST | /pending-operations/approve | confirm_pending_operation | pending-operations-approve-dual | — | policy | api |
| CAP-020 | `cancel_pending_operation` | Cancel a pending operation | agent/operator | event-driven | critical | `POST /pending-operations/reject` | No dedicated surface | chat | api-only | command | POST | /pending-operations/reject | cancel_pending_operation | pending-operations-reject-dual | — | policy | api |
| CAP-021 | `undo_last_action` | Undo the latest eligible mutation | member/owner | on-demand | critical | `POST /pending-operations/undo` | No dedicated surface | chat | api-only | command | POST | /pending-operations/undo | undo_last_action | pending-operations-undo | — | policy | api |
| CAP-022 | `create_credit_card_account` | Create a credit-card account and billing cycle | member | daily | medium | `POST /cards` | Cards | UI | covered | command | POST | /cards | — | cards-create | — | none | api |
| CAP-023 | `create_card_purchase` | Add a purchase to an open card statement | member | daily | high | `POST /cards/purchases` | Cards | UI | covered | command | POST | /cards/purchases | — | cards-purchases-create | — | policy | api |
| CAP-024 | `create_card_installments` | Create all installments across statements | member | daily | high | `POST /cards/installments` | Cards | UI | covered | command | POST | /cards/installments | — | cards-installments-create | — | policy | api |
| CAP-025 | `pay_statement` | Pay a card statement fully or partially | member | daily | critical | `POST /cards/statements/:id/pay` | Cards | UI | covered | command | POST | /cards/statements/:id/pay | — | cards-statement-pay | — | policy | api |
| CAP-026 | `list_statements` | List card statements by account/status | member | daily | medium | `GET /cards/statements` | Cards | UI | covered | query | GET | /cards/statements | — | cards-statements | — | none | api |
| CAP-027 | `get_statement_details` | Read statement total, payment, and purchases | member | daily | medium | `GET /cards/statements/:id` | Cards | UI | covered | query | GET | /cards/statements/:id | — | cards-statement-details | — | none | api |
| CAP-028 | `card_insights` | Compare card spend and rank card categories | member | monthly | low | No equivalent insights route | Cards has statement data, no dedicated insight action | UI | partial | query | — | — | — | — | — | none | planned |
| CAP-029 | `check_card_limits` | Detect card limit usage above thresholds | member | daily | low | No equivalent route | Profile notifications expose related alerts, no command | UI | partial | query | — | — | — | — | — | none | planned |
| CAP-030 | `refresh_statements` | Recompute statement statuses and totals | member | event-driven | medium | No route | Cards reads statements, no refresh action | chat | chat-only | query | — | — | — | — | — | none | planned |
| CAP-031 | `create_recurring_purchase` | Create a recurring card purchase | member | daily | high | `POST /cards/recurring` | Cards has no recurring form | chat | api-only | command | POST | /cards/recurring | — | cards-recurring-create | — | policy | api |
| CAP-032 | `post_due_recurring` | Post recurring purchases due today | agent/operator | event-driven | high | No route | No dedicated surface | internal | internal | command | — | — | — | — | — | policy | planned |
| CAP-033 | `list_recurring_purchases` | List active/paused/cancelled recurring purchases | member | daily | low | `GET /cards/recurring` | No dedicated surface | chat | api-only | query | GET | /cards/recurring | list_recurring_purchases | cards-recurring-list | listRecurringPurchasesTool | none | api |
| CAP-034 | `spending_insights` | Compare spend history and income share | member | monthly | low | `GET /insights/spending` | Reports has local aggregates | UI | covered | query | GET | /insights/spending | — | — | — | none | api |
| CAP-035 | `create_installment_plan` | Create card or out-of-card installment plan | member | on-demand | high | No route | No dedicated surface | chat | chat-only | command | — | — | — | — | — | policy | planned |
| CAP-036 | `list_installment_plans` | List installment plans by type/status | member | on-demand | high | No route | No dedicated surface | chat | chat-only | command | — | — | — | — | — | policy | planned |
| CAP-037 | `pay_installment` | Mark an out-of-card installment paid | member | on-demand | critical | No route | No dedicated surface | chat | chat-only | command | — | — | — | — | — | policy | planned |
| CAP-038 | `list_due_installments` | List due or overdue installments | member | on-demand | medium | No route | No dedicated surface | chat | chat-only | query | — | — | — | — | — | none | planned |
| CAP-039 | `check_due_soon` | Summarize upcoming installment urgency | agent/operator | event-driven | low | No route | No dedicated surface | internal | internal | query | — | — | — | — | — | none | planned |
| CAP-040 | `prepay_installments` | Prepay remaining installments with discount | member | on-demand | critical | No route | No dedicated surface | chat | chat-only | command | — | — | — | — | — | policy | planned |
| CAP-041 | `simulate_prepayment` | Preview installment prepayment cost | member | on-demand | low | No route | No dedicated surface | chat | chat-only | query | — | — | — | — | — | none | planned |
| CAP-042 | `installment_score` | Score installment burden/health | agent/operator | monthly | low | No route | Reports has no equivalent score | internal | internal | query | — | — | — | — | — | none | planned |
| CAP-043 | `createAccountPayable` | Create one-time or recurring payable | member | daily | high | `POST /payables` | Payables | UI | covered | command | POST | /payables | create_account_payable | payables-create | createAccountPayableTool | policy | api |
| CAP-044 | `listAccountsPayable` | List payables by status/type/due window | member | daily | high | `GET /payables` | Payables | UI | covered | query | GET | /payables | list_accounts_payable | payables-list | listAccountsPayableTool | none | api |
| CAP-045 | `markAccountPaid` | Pay a payable and optionally create expense | member | daily | critical | `POST /payables/:id/pay` | Payables | UI | covered | command | POST | /payables/:id/pay | mark_account_paid | payables-pay | markAccountPaidTool | policy | api |
| CAP-046 | `cancelAccountPayable` | Cancel a payable | member | daily | critical | `POST /payables/:id/cancel` | Payables | UI | covered | command | POST | /payables/:id/cancel | cancel_account_payable | payables-cancel | cancelAccountPayableTool | policy | api |
| CAP-047 | `checkPayableReminders` | Find payables needing reminders | member | event-driven | medium | `GET /payables/reminders` | Payables/Profile notification context | UI | covered | query | GET | /payables/reminders | check_payable_reminders | payables-reminders | checkPayableRemindersTool | none | api |
| CAP-048 | `refresh_payable_status` | Advance pending/overdue payable statuses | agent/operator | event-driven | low | `POST /payables/refresh-status` | Payables reads status, no refresh action | internal | internal | command | POST | /payables/refresh-status | refresh_payable_status | payables-refresh-status | refreshPayableStatusTool | policy | api |
| CAP-049 | `createPayableTemplate` | Save a recurring payable template | member | on-demand | high | `POST /payables/templates` | No dedicated template control | chat | api-only | command | POST | /payables/templates | create_payable_template | payables-templates-create | createPayableTemplateTool | policy | api |
| CAP-050 | `createPayableFromTemplate` | Materialize a payable from a template | member | on-demand | high | `POST /payables/from-template` | No dedicated template control | chat | api-only | command | POST | /payables/from-template | create_payable_from_template | payables-from-template | createPayableFromTemplateTool | policy | api |
| CAP-051 | `listPayableTemplates` | List active payable templates | member | on-demand | medium | `GET /payables/templates` | No dedicated template control | chat | api-only | query | GET | /payables/templates | list_payable_templates | payables-templates-list | listPayableTemplatesTool | none | api |
| CAP-052 | `auto_create_from_templates` | Batch-create due payables from templates | agent/operator | event-driven | high | `POST /payables/auto-create-from-templates` | No dedicated surface | internal | internal | command | POST | /payables/auto-create-from-templates | auto_create_from_templates | payables-auto-create-from-templates | autoCreateFromTemplatesTool | policy | api |
| CAP-053 | `payment_score` | Score payment punctuality | agent/operator | monthly | low | No route | Reports has no equivalent score | internal | internal | query | — | — | — | — | — | none | planned |
| CAP-054 | `monthly_projection` | Project payables for a month | member | monthly | low | No route | Reports has no payable projection | chat | chat-only | query | — | — | — | — | — | none | planned |
| CAP-055 | `check_price_alerts` | Detect recurring payable price anomalies | agent/operator | monthly | low | No route | No dedicated surface | internal | internal | query | — | — | — | — | — | none | planned |
| CAP-056 | `configureNotification` | Configure proactive notification schedule | member | event-driven | high | `POST /notifications` | Profile notifications | UI | covered | command | POST | /notifications | — | notifications-create | — | policy | api |
| CAP-057 | `listNotifications` | List active notification settings | member | event-driven | medium | `GET /notifications` | Profile notifications | UI | covered | query | GET | /notifications | — | notifications-list | — | none | api |
| CAP-058 | `deleteNotification` | Remove a notification setting | member/owner | event-driven | critical | No DELETE route | Profile has notification surface, no delete API mapping | UI | partial | command | — | — | — | — | — | policy | planned |
| CAP-059 | `processNotifications` | Process pending notifications for delivery | agent/operator | event-driven | critical | No route | No dedicated surface | internal | internal | command | — | — | — | — | — | policy | planned |
| CAP-060 | `getNotificationLog` | Read sent notification history | agent/operator | event-driven | critical | No route | No dedicated surface | internal | internal | command | — | — | — | — | — | policy | planned |
| CAP-061 | `testNotification` | Preview a notification without sending | agent/operator | event-driven | critical | No route | Profile has notification surface, no preview API | UI | partial | command | — | — | — | — | — | policy | planned |
| CAP-062 | `createGoal` | Create a savings, income, debt, emergency, or purchase goal | member | daily | high | `POST /goals` | Goals, Wallet | UI | covered | command | POST | /goals | — | goals-create | — | policy | api |
| CAP-063 | `listGoals` | List goals with calculated progress | member | daily | medium | `GET /goals` | Goals, Wallet | UI | covered | query | GET | /goals | — | goals-list | — | none | api |
| CAP-064 | `contributeToGoal` | Add a contribution to a goal | member | daily | high | `POST /goals/:id/contribute` | Goals | UI | covered | command | POST | /goals/:id/contribute | — | goals-contribute | — | policy | api |
| CAP-065 | `cancelGoal` | Cancel a goal | member | daily | high | `POST /goals/:id/cancel` | Goals | UI | covered | command | POST | /goals/:id/cancel | — | goals-cancel | — | policy | api |
| CAP-066 | `createBudget` | Create a category spending budget | member | daily | high | `POST /budgets` | Budgets | UI | covered | command | POST | /budgets | — | budgets-create | — | policy | api |
| CAP-067 | `listBudgets` | List budgets with current usage | member | daily | medium | `GET /budgets` | Budgets, Reports | UI | covered | query | GET | /budgets | — | budgets-list | — | none | api |
| CAP-068 | `checkBudgets` | Check all budget thresholds | member | event-driven | high | `GET /budgets/check` | Budgets, Home alerts | UI | covered | query | GET | /budgets/check | — | budgets-check | — | none | api |
| CAP-069 | `refreshGoalsTool` | Recompute achieved/failed goal status | agent/operator | event-driven | high | No route | Goals reads current status, no refresh action | internal | internal | command | — | — | — | — | — | policy | planned |
| CAP-070 | `budgetTrendsTool` | Show budget spend over prior months | member | monthly | medium | `GET /budgets/:id/trends` | Budgets/Reports data, no dedicated trend action | UI | partial | query | GET | /budgets/:id/trends | — | budgets-trends | — | none | api |
| CAP-071 | `suggestBudgetAdjustmentTool` | Suggest a budget from historical spend | agent/operator | monthly | low | No route | Reports has no equivalent suggestion action | internal | internal | query | — | — | — | — | — | none | planned |
| CAP-072 | `updateBudgetTool` | Update budget limit and alert settings | member | daily | high | `PATCH /budgets/:id` | Budgets | UI | covered | command | PATCH | /budgets/:id | - | budgets-update | - | policy | api |
| CAP-073 | `analytics_kpis` | Period KPI totals (income, expense, balance, open invoices, savings rate) | member | daily | low | `GET /analytics/kpis` | PWA charts-data/useAnalytics.ts (kpis) | chat | covered | query | GET | /analytics/kpis | analytics_kpis | analytics-kpis | analyticsKpisTool | none | api |
| CAP-074 | `analytics_category_breakdown` | Expense/income totals per category (one-level macro rollup) in a period | member | daily | low | `GET /analytics/category-breakdown` | PWA charts-data/useAnalytics.ts (category breakdown) | chat | covered | query | GET | /analytics/category-breakdown | analytics_category_breakdown | analytics-category-breakdown | analyticsCategoryBreakdownTool | none | api |

## Coverage summary

| Classification | Count |
|---|---:|
| covered | 35 |
| api-only | 4 |
| partial | 8 |
| chat-only | 14 |
| internal | 11 |
| **Total** | **72** |

## Decisions and follow-up boundary

1. The inventory counts registered Pi capabilities, not source files. The duplicate hyphen/underscore filenames in `.pi/extensions/financial-tools/tools/` do not inflate the count.
2. `chat-only`, `internal`, and `partial` are inventory findings, not automatic deletion decisions. G2.3.2 must add persona, frequency, risk, and final destination before retiring or porting a capability.
3. API presence means an equivalent route, not merely a shared database table. Related aggregates are explicitly marked `partial`.
4. UI presence means a canonical PWA page/control was found in source. A page that only displays related data does not count as full coverage.
