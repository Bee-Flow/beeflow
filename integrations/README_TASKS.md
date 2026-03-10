# Tasks System — README

Architecture, scanner, executor, scheduler, and approval flow.

## Architecture

```
User → TasksPage.jsx → POST /api/tasks/scan/gmail (SSE)
                        → gmailTaskScanner.js (AI tool-calling loop)
                        → Returns proposals via SSE

User clicks "Apply" → POST /api/tasks (creates pending task)
User clicks "Approve" → POST /api/tasks/:id/approve
User opens Tasks page → heartbeat every 30s (stores session)

TaskScheduler (every 60s):
    → Approved tasks → Evaluate triggers
    → User active → execute immediately
    → User away → queue, execute on next heartbeat
```

## Key Files

| File | Purpose |
|------|---------|
| `gmailTaskScanner.js` | AI scans Gmail with gmail_search/gmail_read tools |
| `taskExecutor.js` | Runs approved task actions (label, archive, summarize, draft, etc.) |
| `taskScheduler.js` | Activity-gated trigger evaluation (60s loop) |
| `taskStore.js` | SQLite CRUD + approval gate |
| `tasks.js` | API routes |
| `TasksPage.jsx` | Frontend: Discover + My Tasks tabs, heartbeat, polling |

## Execution Actions

| Action | What it does |
|--------|-------------|
| `label` | Search + identify matching emails |
| `archive` | Search matching emails for archiving |
| `summarize` | Search + read → AI summarize |
| `create_draft` | AI compose email draft |
| `extract_data` | Read emails → AI extract structured data |
| `notify` | Store notification in result |

## Activity-Gated Execution

- Frontend sends `POST /heartbeat` every 30s (stores OAuth session)
- User is "active" if heartbeat < 2 min ago
- Scheduler runs every 60s, evaluates triggers
- If user active → execute. If away → set `queued`
- On next heartbeat → all queued tasks run

## Safety: Two-Step Approval Gate

1. **Apply** → `status: pending`
2. **Approve** → `approved_by` is set
3. **Hard gate** in `taskStore.updateTaskStatus()`:
```js
if (newStatus === 'running' && !task.approved_by) {
    throw new Error('APPROVAL_REQUIRED');
}
```
4. **Double-check** in `taskExecutor.js` before execution

## API Endpoints

All require auth + `tasks` beta feature.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks |
| GET | `/api/tasks/activity` | Scheduler status |
| POST | `/api/tasks` | Create task |
| POST | `/api/tasks/heartbeat` | User presence signal |
| POST | `/api/tasks/scan/gmail` | Gmail scan (SSE) |
| POST | `/api/tasks/:id/approve` | Approve |
| POST | `/api/tasks/:id/reject` | Reject |
| POST | `/api/tasks/:id/run` | Manual trigger |
| DELETE | `/api/tasks/:id` | Delete |
