# Personal BFF

`main.ts` starts Fastify on loopback by default. Terminate HTTPS and WSS at the reverse proxy and omit request query strings from proxy logs because Mobile WS tickets travel in the query. Device credentials are independent from the Connector bearer and stored as hashes. The BFF verifies a device before issuing a short-lived, single-use WS ticket.

The mobile routes save user mutations, optimistic message projections, and Connector commands in one PostgreSQL transaction. The bridge dispatches commands after commit and retries unfinished commands by their original IDs when the Connector reconnects. Connector result and event acknowledgments follow successful database commits. Mobile WebSocket messages indicate which HTTP projections to reload.

The deployment uses one BFF process and one Connector connection. `HERMES_PROFILES` restricts the configured Hermes profiles. A persisted binding joins each ready Topic to its Hermes session, and the bridge assigns those scopes as watches on reconnect.
