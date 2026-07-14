# pushforge examples

Three small files that together form a complete self-hosted push setup:

| File | Runs where | What it shows |
|---|---|---|
| [`subscribe.js`](subscribe.js) | the browser page | registering the service worker, subscribing with your `applicationServerKey`, and shipping the subscription to your backend |
| [`service-worker.js`](service-worker.js) | the browser's service worker | receiving the (already decrypted) push payload and showing a notification |
| [`send.mjs`](send.mjs) | your server (Node) | using the pushforge API directly — store, build, queue, drain — with an injected transport so the example runs offline |

## Try the offline pipeline right now

No browser needed — the mock subscriber generates the same key material a
real `PushManager.subscribe()` call would:

```bash
node dist/cli.js keygen --subject mailto:you@example.test --out vapid.json
node dist/cli.js mock > sub.json           # also writes ua-keys.json
node dist/cli.js add sub.json --tag demo
node dist/cli.js send "hello" --vapid vapid.json --all --dry-run --out outbox
node dist/cli.js decrypt outbox/*.body     # prints: hello
```

## Run the API example

```bash
npm run build
node examples/send.mjs
```

It creates a temp store, enqueues a message for two mock subscribers,
drains the queue through a scripted in-memory transport (one 201, one 410)
and prints the drain report — including the automatic prune of the dead
subscription.
