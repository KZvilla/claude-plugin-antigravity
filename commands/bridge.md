---
description: Diagnose the Telegram bridge — daemon state, which copy of the code each half runs, credentials and shared state
---

Report the health of the Telegram bridge.

Instructions:
1. Call the `mcp__lagrange__telegram_bridge_status` tool. It takes no arguments and only reads.
2. Present the returned report to the user as-is. It is already formatted.
3. Then add a short interpretation, but **only for what the report actually shows** — do not speculate about problems it did not surface:
   - **Two different copies of the code.** This is normal for someone developing the plugin from a clone while the marketplace copy serves the MCP tools, and it is not itself a fault: state and credentials are shared, so `telegram_ask` still round-trips. What it does mean is that a code change reaches only the half that has it. If the user was puzzled by behaviour that ignored an edit or an update, this is almost always why.
   - **No `.env` found.** Telegram is simply unconfigured. Point at the durable location the report names, and at `telegram-bridge/.env.example`.
   - **A `.env` inside a version directory.** It works today and will vanish at the next `claude plugin update`, silently — the symptom appears later, as a tool reporting "No hay usuarios configurados". Suggest moving it to the durable path the report names.
   - **The scheduled task is not registered.** The outbound tools (`telegram_notify`, `telegram_send_voice`, `agy_narrate`) work without it; the daemon is only needed to message the bot *from* the phone and to answer `telegram_ask`. To install it: `npm run bridge:daemon:install` **from a git clone** — the script refuses to install from a managed plugin copy, because the scheduled task stores an absolute path and would stay pinned to one version.
   - **The task is registered but no process is alive.** Look at `telegram-bridge/daemon.log` (`npm run bridge:daemon:logs`) before restarting anything.
4. If everything agrees, say so in one line. Do not pad a healthy report with advice.
