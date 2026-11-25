import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { csrf } from "hono/csrf";

export type BoardOptions = {
  queue: Queue;
  user: string;
  password: string;
};

/** Bull Board for the pipeline's queue (ADR 0017). Nothing is served without the password. */
export function createBoardApp({ queue, user, password }: BoardOptions) {
  const app = new Hono();
  app.use(basicAuth({ username: user, password, realm: "SisaKu pipeline" }));
  // The browser sends the password with requests from other sites too.
  app.use(csrf());

  const adapter = new HonoAdapter(serveStatic).setBasePath("/");
  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter: adapter,
    options: { uiConfig: { boardTitle: "SisaKu pipeline" } },
  });
  return app.route("/", adapter.registerPlugin());
}
