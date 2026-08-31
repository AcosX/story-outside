// tests/health.test.mjs — minimal smoke test for the demo HTTP API.
// Spins the server on an ephemeral port, hits /api/health and /api/stories.

import http from "node:http";
import { once } from "node:events";

import { server } from "../src/server.mjs";

const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on("error", reject);
});

const baseUrl = `http://127.0.0.1:${PICK}`;
let failures = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

await new Promise((resolve) => server.listen(PICK, "127.0.0.1", resolve));

try {
  // /api/health
  {
    const res = await fetch(`${baseUrl}/api/health`);
    const data = await res.json();
    check("GET /api/health 200", res.status === 200, `status=${res.status}`);
    check(
      "/api/health demo flag",
      data && data.demo && data.demo.mode === "demo",
      JSON.stringify(data.demo || null)
    );
    check(
      "/api/health official flag false",
      data && data.demo && data.demo.official_zhihu_api === false
    );
    check(
      "/api/health has version",
      data && typeof data.version === "string"
    );
  }

  // /api/stories
  {
    const res = await fetch(`${baseUrl}/api/stories`);
    const data = await res.json();
    check("GET /api/stories 200", res.status === 200);
    check(
      "/api/stories returns list",
      Array.isArray(data.stories) && data.stories.length >= 1
    );
    check(
      "/api/stories first item has id",
      data.stories[0] && typeof data.stories[0].id === "string"
    );
  }

  // /api/stories/:id
  {
    const res = await fetch(`${baseUrl}/api/stories/cafe-rain`);
    const data = await res.json();
    check("GET /api/stories/cafe-rain 200", res.status === 200);
    check(
      "/api/stories/:id has beats",
      data.story && Array.isArray(data.story.beats) && data.story.beats.length >= 1
    );
    const notFound = await fetch(`${baseUrl}/api/stories/does-not-exist`);
    check("GET /api/stories/:bad 404", notFound.status === 404);
  }

  // /api/stories/advance
  {
    const res = await fetch(`${baseUrl}/api/stories/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyId: "cafe-rain", roleId: "stranger", index: 0 }),
    });
    const data = await res.json();
    check("POST /api/stories/advance 200", res.status === 200);
    check(
      "advance increments index",
      data && data.index === 1 && typeof data.beat === "string"
    );
  }

  // /api/chat
  {
    const ok = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    const data = await ok.json();
    check("POST /api/chat 200", ok.status === 200);
    check("chat echoes user text", data && typeof data.reply === "string");

    const empty = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    check("POST /api/chat empty 400", empty.status === 400);
  }

  // Static index.html
  {
    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    check("GET / 200", res.status === 200);
    check("index.html contains title", text.includes("故事之外"));
    check("index.html contains tagline", text.includes("如果当时，由你来选"));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall checks passed`);