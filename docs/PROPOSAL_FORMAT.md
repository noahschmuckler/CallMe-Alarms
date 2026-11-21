# CallMe proposal format, version 1

Response to "CallMe - manual reminder commands spec" draft v0.3 (Nov 21, 2026).
This is what the app accepts once deployed. It is built and tested but **not deployed**, and
no transport is enabled: until Noah sets a `PLAN_TOKEN`, only the copy/paste route works.

## 1. What intake can and cannot do

- Every proposal, whether pasted by Noah into CallMe or sent to the inbox, becomes an **inert draft**.
  Intake has no path to approve, arm or place a call.
- Only Noah, signed in to CallMe, can approve or reject a draft. Approval covers the whole draft exactly
  as displayed: the page sends a hash of the reviewed content, and approval fails if anything differs.
  Drafts cannot be edited; a change means a new proposal.
- Approval of a draft is claimed atomically, so a double click or a second tab cannot apply it twice.
- The phone number is fixed in the app (ending 0221). Proposals cannot name a destination, a URL, code,
  or credentials. Unknown fields are rejected, so a field such as `"approved": true` is refused, not ignored.
- Text is shown to Noah as plain text and spoken as written.

## 2. Routes

| Route | Who | Does |
|---|---|---|
| Paste box in CallMe ("Paste a proposal") | Noah, signed in | Stages a draft. JSON may be surrounded by other text; everything from the first `{` to the last `}` is read. |
| `POST /inbox/proposal` with `Authorization: Bearer <PLAN_TOKEN>` | A transport, once Noah sets it up | Stages a draft. Same parser, same deduplication. |
| `GET /inbox/receipt?command_id=…` with the same token | The assistant | Returns the current authoritative state of one command. |

Host: `https://callme-alarms.noah-schmuckler.workers.dev`. The token can only stage drafts and read receipts;
it cannot reach the owner app or any other endpoint. Noah configures the token; it never goes in
copy-ready text.

## 3. Grammar

One command, or an envelope holding several (reviewed and approved together as one draft):

```json
{ "version": 1, "title": "Monday", "note": "Optional summary for Noah", "commands": [ {…}, {…} ] }
```

### create

```json
{
  "version": 1,
  "action": "create",
  "command_id": "cmd-2026-12-07-trash-1",
  "reminder_id": "rem-2026-12-07-trash",
  "label": "Trash out",
  "planned_text_at": "2026-12-07T19:00:00-05:00",
  "call_at": "2026-12-07T19:30:00-05:00",
  "timezone": "America/New_York",
  "message": "You planned to take out the trash. Is that done?",
  "policy": {
    "repeats": 1,
    "snooze_minutes": 30,
    "max_snoozes": 1,
    "if_unacknowledged": "keep_calling",
    "retry_every_minutes": 3,
    "allow_quiet_hours": false
  }
}
```

### cancel

```json
{ "version": 1, "action": "cancel", "command_id": "cmd-2026-12-07-trash-cancel", "reminder_id": "rem-2026-12-07-trash", "expected_revision": 1 }
```

### replace (change an approved reminder)

```json
{ "version": 1, "action": "replace", "command_id": "cmd-2026-12-07-trash-change", "reminder_id": "rem-2026-12-07-trash",
  "expected_revision": 1, "new_reminder_id": "rem-2026-12-07-trash-b",
  "label": "Trash out", "call_at": "2026-12-07T20:15:00-05:00", "timezone": "America/New_York",
  "message": "You planned to take out the trash. Is that done?", "policy": { "snooze_minutes": 30 } }
```

All create fields describe the new reminder (same rules), plus `expected_revision` (current revision of the
reminder being replaced) and `new_reminder_id` (must differ from `reminder_id` and be unused). Noah sees one
"CHANGE" with the old and new versions side by side. On approval, in one database step, the old reminder and
any snooze or repeat call it has queued are cancelled and the new reminder is armed. If a call for the old
reminder is in progress (or just ended and is still being recorded), nothing changes: state `too_late`.

### Field rules

| Field | Rules |
|---|---|
| `version` | `1`, on the envelope and on every command. |
| `command_id`, `reminder_id` | 1-100 characters: letters, digits, `. _ : -`, starting with a letter or digit. Unique within a proposal. |
| `label` | 1-80 characters. |
| `call_at` | RFC 3339 with seconds `00` and a numeric offset, e.g. `2026-12-07T19:30:00-05:00`. The offset must be New York's offset at that moment. Rejected: `Z`, wrong offsets, times skipped by the spring-forward change, times in the repeated fall-back hour, and anything less than 2 minutes in the future. |
| `planned_text_at` | Optional, same format, not after `call_at`. Stored and shown to Noah; it never moves the call. |
| `timezone` | Exactly `America/New_York`. |
| `message` | 1-700 characters (the keypad menu is added after it, keeping the total within the 1,000-character call limit). |
| `policy` | Required object; `{}` means one call, no snooze, no repeat calls. Fields below. |
| `policy.repeats` | 1-5, default 1. Times the message plays within one call. |
| `policy.snooze_minutes` | 0-60, default 0 (off). |
| `policy.max_snoozes` | 1 when snooze is on (owner limit; anything higher is rejected). |
| `policy.if_unacknowledged` | `none` (default), `retry` or `keep_calling`. |
| `policy.retry_every_minutes` | 2-30. Required for `retry` and `keep_calling`, not allowed for `none`. |
| `policy.max_retries` | 1-5. Required for `retry`, not allowed otherwise. |
| `policy.allow_quiet_hours` | `true` only if Noah agreed to this specific call being in quiet hours. Default `false`. |
| `expected_revision` | The `schedule_revision` from the create receipt. |

Limits: 64 KB per submission, 30 commands, 10 drafts waiting for review, 120 commands per hour.
Drafts not reviewed within 7 days expire.

## 4. Call behaviour (owner-approved policy)

- **Menu.** With snooze on, the call ends "Press 1 if you're up. Press 2 to snooze for 30 minutes."
  After the snooze is used: "Press 1 when you're getting out of bed. I'll keep calling until you do."
  (or "Press 1 to confirm." for `retry`). Every call then adds "Press 3 to leave a spoken update."
- **Press 1:** done. Recorded as a response event. Nothing more is called.
- **Press 2, snooze left:** the call answers "Okay, snoozed. I'll call you back at 7:01 AM. Goodbye."
  (`snooze_minutes` after the keypress, rounded up to the minute), and CallMe places one call at exactly
  that time. Max 1 snooze.
- **Press 3, spoken update:** counts as an answer (nothing more is called). After a recording notice and a
  beep, Noah speaks for up to 45 minutes; it ends after 60 seconds of silence or on #. After the call the
  phone backend transcribes it and saves the transcript to Google Drive (CallMe folder). Audio is deleted
  from Twilio after 7 days.
- **Not acknowledged** (hang-up, no answer, voicemail, any other key, or 2 with no snooze left):
  - `keep_calling`: calls again every `retry_every_minutes` until 1 is pressed.
  - `retry`: calls again up to `max_retries` times.
  - `none`: stops.
- **Quiet hours: 10:30 PM to 5:00 AM.** No call is placed in quiet hours unless that schedule was
  explicitly allowed (`allow_quiet_hours`, or the checkbox in the app). Snooze and repeat calls stop at
  10:30 PM. A proposal whose `call_at` is in quiet hours without `allow_quiet_hours: true` is rejected.
- **Safety stop:** `keep_calling` stops 2 hours after the first call, so a dead phone cannot loop all day.
- **No catch-up:** a call more than 5 minutes late, or a snooze/repeat call more than 10 minutes late
  (downtime, master pause), is dropped, never placed late.
- Master pause blocks everything, including snooze and repeat calls.

## 5. State model

Draft: `pending` → `approved` | `rejected` | `expired`.

Command receipt `state`:

| State | Meaning |
|---|---|
| `draft_received` | Staged. Not approved, not armed. |
| `rejected` | Noah rejected the draft. Nothing changed. |
| `expired` | Draft expired, or the call time passed before approval. Not scheduled; no catch-up call. |
| `armed` | Approved; will ring at `call_at` (calling connected, master pause off). |
| `saved_inactive` | Approved and saved, but will not ring now: master pause is on or calling is not connected. `detail` says which. |
| `called` | The call time has come and gone; see `events`. |
| `turned_off_by_owner`, `deleted_by_owner` | Noah turned it off or deleted it in the app. |
| `cancelled` | Cancelled (for a create: the reminder; for a cancel: the cancel succeeded). |
| `cancel_too_late` | A call was already sent or ringing when the cancel was approved. It may have rung. No further calls are placed. |
| `nothing_pending` | Cancel or replace approved, but the reminder had already finished or been turned off (or was already replaced). Nothing changed. |
| `too_late` | Replace approved while a call for the old reminder was in progress. Nothing changed; send the change again in a few minutes. |
| `replaced` | (Receipt of the old reminder's create.) It was replaced; `replaced_by` names the new reminder. |
| `conflict` | Cancel approved, but the revision no longer matched or the reminder vanished. Nothing changed. |

Receipt example (create, after the call):

```json
{
  "command_id": "cmd-2026-12-07-trash-1", "reminder_id": "rem-2026-12-07-trash", "action": "create",
  "draft_id": "d_4f0c1a2b3c4d5e6f", "draft_revision": 1, "state": "called", "detail": "Approved by Noah",
  "received_at": "2026-12-05T15:00:00.000Z", "decided_at": "2026-12-05T15:20:00.000Z",
  "call_at": "2026-12-07T19:30:00-05:00", "timezone": "America/New_York", "schedule_revision": 1,
  "server_time": "2026-12-08T01:10:00.000Z",
  "events": [
    { "at": "2026-12-08T00:31:00.000Z", "kind": "call_ended", "call_status": "completed", "digits": "2", "outcome": "snoozed" },
    { "at": "2026-12-08T01:02:00.000Z", "kind": "call_ended", "call_status": "completed", "digits": "1", "outcome": "acknowledged" }
  ]
}
```

Event `outcome`: `acknowledged`, `spoken_update`, `snoozed`, `calling_again`, `quiet_hours`, `safety_stop`, `policy_done`
(policy allowed no more calls), `cancelled`, `not_acknowledged` (no policy). "Acknowledged" means 1 was
pressed on the call. It does not prove who pressed it, and it is not verified task completion.

## 6. Revisions and cancellation

- An approved create is a one-time schedule at revision 1. Each edit Noah saves in the app adds 1.
- A cancel must carry the current revision. A mismatch, or an unknown `reminder_id`, is rejected at intake
  (409) and again at approval, with no change.
- Cancels are proposals too: they wait in a draft for Noah's approval, like creates. Noah can also turn a
  schedule off or delete it directly in the app.
- Cancel and dispatch are decided in single database steps. If the cancel lands first, the call is never
  placed. If the call was already sent, the result is `cancel_too_late`, and any snooze or repeat call that
  call would have started is blocked. A call already ringing cannot be stopped.

## 7. Intake responses and errors

| Status | Body | Meaning |
|---|---|---|
| `202` | `{"ok":true,"draft_id":"d_…","draft_revision":1,"receipts":[…]}` | Staged as a draft. |
| `200` | `{"ok":true,"draft_id":null,"receipts":[{…,"duplicate":true}]}` | Every command was already received with identical content. Nothing new. Safe to resend. |
| `400` | `{"error":"invalid_proposal","problems":["commands[1]: \"call_at\" …"]}` | Nothing saved. Fix and resend. |
| `401` | `{"error":"unauthorized"}` | Missing or wrong token. |
| `409` | `{"error":"conflict","problems":[…]}` | A `command_id` reused with different content, a `reminder_id` reused with different content, or a cancel with an unknown reminder or stale revision. Nothing saved. |
| `413` | `too_large` | Over 64 KB. |
| `429` | `too_many_pending` / `rate_limited` | 10 drafts already waiting, or over 120 commands in an hour. |
| `500` | `{"error":"server_error","problems":["Status unknown. Resending the same command_id is safe."]}` | Resend the same command, never a new `command_id`. |

Resending the same `command_id` with the same content always returns its current receipt and never creates
a second draft or call. Copy/paste and the inbox converge on the same `command_id`.

## 8. Not built yet

- **Delivering spoken updates to Instinct directly.** Transcripts are saved to Drive; a direct route
  (signed webhook, email, or Instinct checking Drive) is Instinct's choice. The phone backend's source is
  in `noahschmuckler/callme-server`.
- **Transport.** No email, text or webhook sender is set up. The inbox endpoint exists for one; enabling it
  needs Noah to set `PLAN_TOKEN` and choose the sender.
- **Snooze by text message** is not supported.
