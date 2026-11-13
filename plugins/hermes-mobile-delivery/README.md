# Hermes Mobile delivery plugin

The `hermes_mobile` platform queues outbound text for the Mobile Inbox. Run Hermes Agent and the Connector as the same Unix user. The Connector uses Python 3.11+ to read and acknowledge the plugin's SQLite queue through local subprocess pipes.

1. Copy this directory, including `plugin.yaml`, `__init__.py`, and `src/`, into the sending Hermes profile's `plugins/hermes-mobile-delivery` directory. For the default profile, that is `~/.hermes/plugins/hermes-mobile-delivery`. Enable it with `hermes plugins enable hermes-mobile-delivery` from that profile.
2. In that profile's `.env`, set `HERMES_MOBILE_HOME_CHANNEL=1` and `HERMES_MOBILE_SPOOL_PATH` to an absolute filename such as `/Users/you/.hermes/mobile-delivery/queue.sqlite3`. Use a dedicated parent directory, which the plugin creates with mode `0700` if absent. For a named profile, set `HERMES_MOBILE_PROFILE` to its exact name and include that profile in the BFF's `HERMES_PROFILES`.
3. Set the same absolute `HERMES_MOBILE_SPOOL_PATH` in the Connector environment. It uses `python3` from `PATH` by default. Set `HERMES_MOBILE_PYTHON` to the desired executable when needed. Restart the Hermes Gateway if it is running and start or restart the Connector.

Send a smoke message with `hermes send --to hermes_mobile "Hello from Hermes"`, or set a Cron job's delivery target to `hermes_mobile`. The configured home target can also be addressed as `hermes_mobile:1`. Other targets and thread IDs are rejected.

Hermes reports success when the plugin commits the text locally. The Connector retries with the same delivery ID until the BFF durably acknowledges it. Hermes does not provide a stable identity for every upstream delivery part, so a separate send call is recorded as a separate Inbox item, even with identical text. Delivery is limited to text up to 128 KiB. Native attachments are unsupported.
