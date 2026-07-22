import { describe, expect, test } from "bun:test";
import { nativeGptModels, targetOptions } from "../gui/src/model-route-data";

describe("model routing GUI data", () => {
  test("keeps native catalog rows eligible as replacement sources", () => {
    expect(nativeGptModels([
      { provider: "openai", id: "gpt-5.4", native: true },
      { provider: "zai-anthropic", id: "glm-5.2", native: false },
      { provider: "openai", id: "gpt-5.4-mini" },
      { provider: "other", id: "gpt-5.5", native: true },
    ])).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
  });

  test("builds deduplicated provider and combo target options", () => {
    expect(targetOptions([
      { provider: "openai", id: "gpt-5.4", namespaced: "openai/gpt-5.4", native: true },
      { provider: "zai-anthropic", id: "glm-5.2" },
      { provider: "zai-anthropic", id: "glm-5.2", namespaced: "zai-anthropic/glm-5.2" },
    ], [
      { id: "free", model: "combo/free" },
      { id: "free", model: "combo/free" },
    ])).toEqual([
      "combo/free",
      "openai/gpt-5.4",
      "zai-anthropic/glm-5.2",
      "zai-anthropic/glm-5.2",
    ].filter((value, index, values) => values.indexOf(value) === index));
  });
});
