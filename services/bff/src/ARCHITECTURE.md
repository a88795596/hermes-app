# Personal BFF

`main.ts` starts Fastify on loopback by default. Terminate HTTPS and WSS at the reverse proxy and omit request query strings from proxy logs because Mobile WS tickets travel in the query. Device credentials are independent from the Connector bearer and stored as hashes. The BFF verifies a device before issuing a short-lived, single-use WS ticket.

The mobile routes save user mutations, optimistic message projections, and Connector commands in one PostgreSQL transaction. The bridge dispatches commands after commit and retries unfinished commands by their original IDs when the Connector reconnects. Connector result and event acknowledgments follow successful database commits. Mobile WebSocket messages indicate which HTTP projections to reload.

The deployment uses one BFF process and one Connector connection. `HERMES_PROFILES` restricts the configured Hermes profiles. A persisted binding joins each ready Topic to its Hermes session, and the bridge assigns those scopes as watches on reconnect.

Device-authenticated management requests resolve the profile through the same allowlist. The bridge sends them on the live Connector socket and returns the correlated result. Management is available when the Connector advertises its Dashboard integration. Changes go directly to Hermes. In-flight management calls are kept in memory and a dropped connection leaves the outcome of a dispatched write unconfirmed.
