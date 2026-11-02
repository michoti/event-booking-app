import { createServer } from "node:http";
import * as client from "prom-client";

// Prometheus metrics on an INTERNAL port (not published to the host).
const g = globalThis as unknown as { __metricsStarted?: boolean };

if (!g.__metricsStarted) {
  g.__metricsStarted = true;
  client.collectDefaultMetrics({ prefix: "eventbooking_" });

  const port = Number(process.env.METRICS_PORT ?? 9464);
  createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  }).listen(port, "0.0.0.0");
}