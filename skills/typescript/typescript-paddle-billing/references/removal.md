# Removal

*Moved from SKILL.md section 16. Read it when asked to remove Paddle from the app, or when Paddle access is lost.*

To remove Paddle from the app: deactivate or delete the notification destination (`updateNotificationSetting({ notificationSettingId, body: { active: false } })` or the dashboard); remove the env vars; delete `server/paddle/`, `scripts/paddle/`, the web files and the routes; keep the tables until the data is exported (transactions and invoices stay in Paddle). Do not archive products or cancel subscriptions as part of code removal; those are business decisions the owner makes in the dashboard, and canceling is irreversible.

If Paddle access is lost outside the app (key revoked or expired, account suspended, destination deleted): webhooks stop, so the mirror goes stale. The app must fail closed for new purchases (hide buy buttons with a notice), keep existing entitlements as they are, alert the owner, and resume by creating a new key and destination (`paddle-setup.ts webhook`), then replaying missed notifications (`client.notifications.replayNotification`; the redelivered events are recorded and applied like new ones).
