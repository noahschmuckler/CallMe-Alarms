# CallMe plan format (`callme-plan/1`)

How an assistant (Instinct) proposes calls to CallMe Alarms. A plan only **waits for review**.
Nothing is scheduled and nothing calls until Noah opens the CallMe app and taps **Approve and turn on**.

## Sending a plan

```
POST https://callme-alarms.noah-schmuckler.workers.dev/inbox/plan
Authorization: Bearer <PLAN_TOKEN>
Content-Type: application/json

{ ...plan... }
```

- The body can also be plain text with the JSON plan inside it (for example an email body).
  Everything from the first `{` to the last `}` is read as the plan.
- Maximum 64 KB, 30 calls per plan, 10 plans waiting for review at once.
- Plans not reviewed within 7 days expire.

| Response | Meaning |
|---|---|
| `202` `{"ok":true,"plan_id":"…","status":"pending"}` | Received. Waiting for Noah. |
| `400` `{"error":"invalid_plan","problems":[…]}` | Nothing saved. Each problem names the field, e.g. `calls[2]: Choose a valid time and repeat pattern.` Fix and resend. |
| `401` | Wrong or missing token. |
| `429` | Ten plans are already waiting. |

## The plan

```json
{
  "format": "callme-plan/1",
  "title": "Week of Dec 7",
  "note": "Clinic Monday and Wednesday. Long drive Tuesday.",
  "calls": [
    {
      "label": "Clinic wake",
      "date": "2026-12-07",
      "time": "05:45",
      "say": "Good morning Noah. It's Monday, a clinic day. First patient at 8.",
      "repeats": 2,
      "snooze_minutes": 30,
      "max_snoozes": 1,
      "retry_minutes": 5,
      "max_retries": 2
    },
    {
      "label": "Evening check-in",
      "repeat": "weekdays",
      "time": "22:00",
      "say": "Time to wind down. Have you told Leslie good night?"
    }
  ]
}
```

| Field | Required | Rules |
|---|---|---|
| `format` | yes | Exactly `callme-plan/1`. |
| `title` | yes | Up to 100 characters. Shown as the heading Noah reviews. |
| `note` | no | Up to 1000 characters. A short summary for Noah. |
| `calls[].label` | yes | Up to 80 characters. |
| `calls[].date` | one of | `YYYY-MM-DD`, for a one-time call. Must still be in the future when Noah approves; past ones are skipped. |
| `calls[].repeat` | one of | `weekdays`, `every day` (or `daily`), `weekends`. Use `date` or `repeat`, not both. |
| `calls[].time` | yes | 24-hour `HH:MM`, America/New_York time. |
| `calls[].say` | yes | The words spoken by text-to-speech, up to 800 characters including the snooze menu (about 70 characters, added automatically). Write it the way it should sound: spell out anything ambiguous, avoid abbreviations and symbols. |
| `calls[].repeats` | no | 1-5, default 1. How many times the message plays within one call. |
| `calls[].snooze_minutes` | no | 0-60, default 0 (off). If on, the call ends with "Press 1 if you're up. Press 2 to snooze for N minutes." |
| `calls[].max_snoozes` | no | 1-3, default 1. The last call says "This is your last call. Press 1 if you're up." |
| `calls[].retry_minutes` | no | 0 (off) or 2-30, default 0. If the call isn't answered, goes to voicemail, or no key is pressed, call again after this many minutes. |
| `calls[].max_retries` | no | 1-5, default 2. |

## Behaviour after approval

- Each call becomes a normal schedule, turned on, marked "from a plan". Noah can edit, turn off or delete it.
- The master pause still applies to everything.
- Snooze: pressing 2 schedules one more call `snooze_minutes` after the original call started.
  Pressing 1 ends the sequence. Pressing 2 when no snoozes are left counts as unanswered.
- Snooze and retry calls more than 10 minutes overdue (downtime, pause) are dropped, never replayed.
- One-time schedules are removed two days after they ran.
