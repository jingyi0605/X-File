import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../app.js";

test("文档库主路由、标签路由和 server state 都已注册", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-routes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-routes-library-"));
  fs.writeFileSync(path.join(rootDir, "a.doc"), "office", "utf8");
  const app = createServer({ httpServerRuntimeState: { running: false } });

  try {
    const binding = await app.inject({
      method: "PUT",
      url: "/api/library/binding",
      payload: { rootDir }
    });
    assert.equal(binding.statusCode, 200);
    assert.equal(binding.json().rootDir, rootDir);

    const config = await app.inject({ method: "GET", url: "/api/library/config" });
    assert.equal(config.statusCode, 200);
    assert.equal(config.json().allowedExtensions.includes(".doc"), true);

    const tags = await app.inject({ method: "GET", url: "/api/library/tags" });
    assert.equal(tags.statusCode, 200);
    assert.equal(Array.isArray(tags.json().items), true);

    const createdTag = await app.inject({
      method: "POST",
      url: "/api/library/tags/ensure",
      payload: { path: "主题/路由" }
    });
    assert.equal(createdTag.statusCode, 200);
    const tagId = createdTag.json().id;

    const tagDetail = await app.inject({ method: "GET", url: `/api/library/tags/${tagId}` });
    assert.equal(tagDetail.statusCode, 200);
    assert.equal(tagDetail.json().path, "主题/路由");

    const updatedTag = await app.inject({
      method: "PUT",
      url: `/api/library/tags/${tagId}`,
      payload: { name: "路由设计" }
    });
    assert.equal(updatedTag.statusCode, 200);
    assert.equal(updatedTag.json().path, "主题/路由设计");

    const documentTags = await app.inject({
      method: "PUT",
      url: "/api/library/documents/docs%2Fa.md/tags",
      payload: { tagIds: [tagId] }
    });
    assert.equal(documentTags.statusCode, 200);
    assert.equal(documentTags.json().manualTagIds[0], tagId);

    const folderTags = await app.inject({
      method: "PUT",
      url: "/api/library/folders/tags",
      payload: { folderPath: "docs", tagIds: [tagId] }
    });
    assert.equal(folderTags.statusCode, 200);
    assert.equal(folderTags.json().bindingTagIds[0], tagId);

    const savedFavorites = await app.inject({
      method: "PUT",
      url: "/api/library/favorites",
      payload: { favorites: [{ kind: "tag", path: "主题/路由设计", label: "路由设计" }] }
    });
    assert.equal(savedFavorites.statusCode, 200);
    assert.equal(savedFavorites.json().items[0]?.path, "主题/路由设计");

    const deletedTag = await app.inject({ method: "DELETE", url: `/api/library/tags/${tagId}` });
    assert.equal(deletedTag.statusCode, 200);
    assert.equal(deletedTag.json().deletedTagIds[0], tagId);

    const state = await app.inject({ method: "GET", url: "/api/server/state" });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().host, "127.0.0.1");

    const refresh = await app.inject({
      method: "POST",
      url: "/api/library/refresh",
      payload: { reason: "route_test" }
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json().status.state, "queued");

    const snapshot = await app.inject({ method: "GET", url: "/api/library/snapshot" });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(["queued", "running", "failed", "queue_timeout", "fresh", "cooldown"].includes(snapshot.json().status.state), true);

    const integration = await app.inject({ method: "GET", url: "/api/integration/status" });
    assert.equal(integration.statusCode, 200);
    assert.equal(integration.json().api.serverState, "/api/server/state");
  } finally {
    await app.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
