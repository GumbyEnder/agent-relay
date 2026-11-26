#!/usr/bin/env node
// Stand-in BeeZilla cloud for manual probing: serves /connect + a minting endpoint.
import { createServer } from "node:http";

let n = 0;
const mode = process.env.MODE ?? "ok";
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  console.log(`${req.method} ${url}`);
  if (url === "/connect") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Connect BeeZilla</title><h1>Sign in to BeeZilla</h1>");
    return;
  }
  if (url.startsWith("/api/inference-token")) {
    n++;
    if (mode === "notconfigured") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "not_configured", error: "inference tokens are not configured on this deployment" }));
      return;
    }
    if (mode === "signin" && n === 1) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "unauthenticated", error: "sign in to use BeeZilla inference" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        token: "bz1.fake.payload",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        baseUrl: "https://inference-api.nousresearch.com/v1",
        model: "z-ai/glm-5.3-flash",
      }),
    );
    return;
  }
  res.writeHead(404).end("not found");
});
server.listen(Number(process.env.PORT ?? 8155), "127.0.0.1", () => console.log("fake cloud ready"));
